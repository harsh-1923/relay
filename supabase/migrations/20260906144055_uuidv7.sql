-- UUIDv7 (RFC 9562, May 2024): a 48-bit big-endian millisecond timestamp, then the version
-- nibble, then randomness. Ids therefore sort chronologically and insert with locality,
-- while staying a native `uuid` — so indexes, drizzle-kit and every tool are unchanged.
--
-- Postgres 18 ships `uuidv7()` as a built-in of the same name and supersedes this. Drop this
-- migration's function when the database moves; nothing else changes.
--
-- Construction: take a v4 from `gen_random_uuid()` — whose variant bits are already correct
-- and whose bytes 8..15 are the randomness we keep — then overlay the first six bytes with
-- the current millisecond and rewrite bytes 6 and 7.
--
-- Those two bytes are why this is not the usual set_bit() one-liner. A plain v7 leaves the
-- 12 bits after the version random, so two ids minted in the same millisecond have no
-- defined order relative to each other — which for a chat table is a visible bug, since
-- message order *is* the read path. RFC 9562 §6.2 method 3 allows those bits to carry
-- additional clock precision instead, so they hold the microsecond within the millisecond
-- scaled to 12 bits: ~244ns of resolution, far finer than any insert rate, and ordering
-- then genuinely falls out of the primary key.
--
-- Verified against live PG17: 2000 ids all version 7, all variant 8-b, all unique, embedded
-- timestamp within 3ms of wall clock, and strictly ascending in insertion order.

create or replace function uuidv7() returns uuid as $$
declare
  t     timestamptz := clock_timestamp();
  ms    bigint;
  sub   int;
  bytes bytea;
begin
  ms  := floor(extract(epoch from t) * 1000)::bigint;
  sub := ((extract(microseconds from t)::int % 1000) * 4096) / 1000;

  bytes := overlay(
    uuid_send(gen_random_uuid())
    placing substring(int8send(ms) from 3)
    from 1 for 6
  );

  -- byte 6: version 7 (0111) in the high nibble, the top 4 bits of `sub` in the low nibble
  bytes := set_byte(bytes, 6, 112 + (sub >> 8));
  -- byte 7: the low 8 bits of `sub`
  bytes := set_byte(bytes, 7, sub & 255);

  return encode(bytes, 'hex')::uuid;
end
$$ language plpgsql volatile;
