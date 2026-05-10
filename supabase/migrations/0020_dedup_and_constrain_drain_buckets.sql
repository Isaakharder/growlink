-- Remove duplicate irrigation_drain_buckets rows, keeping the oldest per
-- (organization_id, group_id, name). One duplicate was found on 2026-05-10
-- from a double-submit: "Bucket 11" had two rows 9 seconds apart.
DELETE FROM public.irrigation_drain_buckets
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY organization_id, group_id, name
        ORDER BY created_at ASC
      ) AS rn
    FROM public.irrigation_drain_buckets
  ) ranked
  WHERE rn > 1
);

-- Enforce uniqueness going forward.
ALTER TABLE public.irrigation_drain_buckets
  ADD CONSTRAINT irrigation_drain_buckets_org_group_name_key
  UNIQUE (organization_id, group_id, name);
