#!/usr/bin/env python3
"""
Migration: PostgreSQL embeddings → Qdrant vector store.

Reads all non-archived memories with embeddings from PostgreSQL (athene_memory),
upserts them into Qdrant collection 'memories' via REST API.

Usage:
    python migrate_vectors_to_qdrant.py migrate [--batch-size 200] [--dry-run]
    python migrate_vectors_to_qdrant.py verify [--sample 10]
"""

import argparse
import asyncio
import json
import sys
import time
from typing import Any

import asyncpg
import httpx

# --- Configuration ---
PG_DSN = "postgresql://postgres:postgres@postgres:5432/athene_memory"
QDRANT_URL = "http://athena-qdrant:6333"
QDRANT_COLLECTION = "memories"
DEFAULT_BATCH_SIZE = 200

# Payload fields to store in Qdrant (beyond vector)
PAYLOAD_FIELDS = [
    "user_id", "namespace", "importance", "content",
    "metadata", "source_type", "source_location",
    "content_hash", "version", "is_archived",
    "created_at", "updated_at",
]


async def count_embeddings(pool: asyncpg.Pool) -> int:
    """Count non-archived records with embeddings."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT count(*) FROM memories "
            "WHERE embedding IS NOT NULL AND is_archived = false"
        )
        return row[0]


async def fetch_batch(
    pool: asyncpg.Pool, offset: int, batch_size: int
) -> list[asyncpg.Record]:
    """Fetch a batch of records with embeddings."""
    async with pool.acquire() as conn:
        return await conn.fetch(
            "SELECT id, user_id, namespace, importance, content, "
            "metadata, source_type, source_location, content_hash, "
            "version, is_archived, created_at, updated_at, "
            "embedding::real[] as embedding "
            "FROM memories "
            "WHERE embedding IS NOT NULL AND is_archived = false "
            "ORDER BY created_at "
            "LIMIT $1 OFFSET $2",
            batch_size,
            offset,
        )


def parse_pgvector(raw: Any) -> list[float]:
    """Parse pgvector value — asyncpg returns it as a string '[0.1,0.2,...]'."""
    if isinstance(raw, list):
        return [float(x) for x in raw]
    # String representation from asyncpg
    s = str(raw).strip("[]")
    if not s:
        return []
    return [float(x) for x in s.split(",")]


def record_to_point(record: asyncpg.Record) -> dict[str, Any]:
    """Convert a PostgreSQL record to a Qdrant point."""
    vector = parse_pgvector(record["embedding"])

    # Build payload
    payload: dict[str, Any] = {}
    for field in PAYLOAD_FIELDS:
        val = record[field]
        if val is not None:
            # asyncpg returns datetime objects — serialize to ISO string
            if hasattr(val, "isoformat"):
                payload[field] = val.isoformat()
            elif isinstance(val, dict):
                payload[field] = val
            else:
                payload[field] = val

    # Qdrant point ID: use UUID string (without dashes for compactness)
    point_id = str(record["id"])

    return {
        "id": point_id,
        "vector": vector,
        "payload": payload,
    }


async def upsert_batch(
    client: httpx.AsyncClient, points: list[dict]
) -> dict:
    """Upsert a batch of points into Qdrant."""
    resp = await client.put(
        f"{QDRANT_URL}/collections/{QDRANT_COLLECTION}/points",
        json={"points": points},
        timeout=120.0,
    )
    resp.raise_for_status()
    return resp.json()


async def migrate(batch_size: int, dry_run: bool) -> None:
    """Run migration."""
    print(f" Connecting to PostgreSQL...")

    pool = await asyncpg.create_pool(PG_DSN, min_size=1, max_size=3)

    try:
        total = await count_embeddings(pool)
        print(f" Found {total} records with embeddings (non-archived)")

        if total == 0:
            print(" Nothing to migrate.")
            return

        if dry_run:
            print(" [DRY RUN] Would migrate", total, "records")
            return

        print(f" Migrating to Qdrant ({QDRANT_URL}/{QDRANT_COLLECTION})")
        print(f" Batch size: {batch_size}")

        migrated = 0
        errors = 0
        start_time = time.monotonic()

        async with httpx.AsyncClient() as client:
            # Verify Qdrant is reachable
            health = await client.get(f"{QDRANT_URL}/collections/{QDRANT_COLLECTION}")
            health.raise_for_status()
            col_info = health.json().get("result", {})
            print(f" Qdrant collection: points={col_info.get('points_count', '?')}, "
                  f"status={col_info.get('status', '?')}")

            offset = 0
            while offset < total:
                batch_records = await fetch_batch(pool, offset, batch_size)
                if not batch_records:
                    break

                points = [record_to_point(r) for r in batch_records]

                try:
                    result = await upsert_batch(client, points)
                    # Qdrant returns {"status": "ok", "result": {"operation_id": N, "status": "completed"}}
                    op_status = result.get("result", {}).get("status", "unknown")
                    if op_status == "completed":
                        migrated += len(points)
                    else:
                        print(f"  ⚠ Unexpected op status: {op_status} | full: {str(result)[:200]}")
                        errors += len(points)
                except httpx.HTTPStatusError as e:
                    body = e.response.text[:300] if e.response else str(e)
                    print(f"  ✗ HTTP {e.response.status_code} at offset {offset}: {body}")
                    errors += len(points)
                except Exception as e:
                    print(f"  ✗ Batch error at offset {offset}: {type(e).__name__}: {e}")
                    errors += len(points)

                offset += batch_size
                pct = min(100, offset * 100 // total)
                elapsed = time.monotonic() - start_time
                rate = migrated / elapsed if elapsed > 0 else 0
                print(f"  [{pct:3d}%] migrated={migrated}, errors={errors}, "
                      f"rate={rate:.0f} pts/s", end="\r")

            # Final line
            elapsed = time.monotonic() - start_time
            print()
            print(f"\n Migration complete in {elapsed:.1f}s")
            print(f"   Migrated: {migrated}")
            print(f"   Errors:   {errors}")

    finally:
        await pool.close()


async def verify(sample: int) -> None:
    """Verify migration: compare counts and spot-check vectors."""
    print(" Verifying migration...\n")

    pool = await asyncpg.create_pool(PG_DSN, min_size=1, max_size=3)

    try:
        # PG count
        pg_count = await count_embeddings(pool)
        print(f" PostgreSQL (non-archived with embedding): {pg_count}")

        # Qdrant count
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{QDRANT_URL}/collections/{QDRANT_COLLECTION}")
            resp.raise_for_status()
            qdrant_count = resp.json()["result"]["points_count"]
        print(f" Qdrant points:                          {qdrant_count}")

        if pg_count == qdrant_count:
            print(f" ✓ Count match!")
        else:
            diff = pg_count - qdrant_count
            print(f" ✗ Count mismatch! Difference: {diff}")

        # Spot-check: fetch random sample from PG and verify in Qdrant
        print(f"\n Spot-check ({sample} random records):")
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT id, namespace, importance FROM memories "
                "WHERE embedding IS NOT NULL AND is_archived = false "
                "ORDER BY random() LIMIT $1",
                sample,
            )

        async with httpx.AsyncClient() as client:
            verified = 0
            for row in rows:
                point_id = str(row["id"])
                resp = await client.get(
                    f"{QDRANT_URL}/collections/{QDRANT_COLLECTION}/points/{point_id}"
                )
                if resp.status_code == 200:
                    point = resp.json()["result"]
                    ns = point.get("payload", {}).get("namespace", "?")
                    imp = point.get("payload", {}).get("importance", "?")
                    vec_len = len(point.get("vector", []))
                    print(f"  ✓ {point_id[:8]}... ns={ns} imp={imp} vec_len={vec_len}")
                    verified += 1
                else:
                    print(f"  ✗ {point_id[:8]}... NOT FOUND (HTTP {resp.status_code})")

            print(f"\n Verified {verified}/{sample}")

    finally:
        await pool.close()


def main():
    parser = argparse.ArgumentParser(description="Migrate embeddings from PG to Qdrant")
    sub = parser.add_subparsers(dest="command")

    mig = sub.add_parser("migrate", help="Run migration")
    mig.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    mig.add_argument("--dry-run", action="store_true")

    ver = sub.add_parser("verify", help="Verify migration results")
    ver.add_argument("--sample", type=int, default=10)

    args = parser.parse_args()

    if args.command == "migrate":
        asyncio.run(migrate(args.batch_size, args.dry_run))
    elif args.command == "verify":
        asyncio.run(verify(args.sample))
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
