-- Maintenance module — Inventory items and the transaction ledger.
--
-- Each inventory item has exactly one location in v1 (maintenance_locations,
-- shared with equipment, from 0127). quantity_on_hand is a cached value that
-- must only ever change through maintenance_apply_inventory_transaction
-- below — every other quantity-changing flow added in 0130 (restock
-- receiving, stock-count corrections) calls through this same function so
-- there is exactly one place that locks the item row, validates the
-- resulting quantity, writes the immutable ledger row, and updates the
-- cache atomically.
--
-- quantity_on_hand uses numeric(14,3), not float (per the product spec —
-- persisted stock quantities and cost must never use floating-point
-- arithmetic) and not a plain integer, so litre/kilogram/metre can carry
-- fractional amounts in the same column that each/box/package use as whole
-- numbers; the application layer rejects non-integer input when
-- unit_of_measure is a discrete unit.

-- ============================================================
-- maintenance_inventory_items
-- ============================================================

create table public.maintenance_inventory_items (
  id                              uuid          primary key default gen_random_uuid(),
  organization_id                 uuid          not null references public.organizations(id) on delete cascade,
  name                            text          not null,
  part_number                     text,
  part_number_normalized          text          generated always as (lower(trim(part_number))) stored,
  part_type_id                    uuid          references public.maintenance_part_types(id) on delete restrict,
  location_id                     uuid          not null references public.maintenance_locations(id) on delete restrict,
  quantity_on_hand                numeric(14, 3) not null default 0 check (quantity_on_hand >= 0),
  unit_of_measure                 text          not null default 'each' check (unit_of_measure in ('each', 'box', 'package', 'litre', 'kilogram', 'metre', 'custom')),
  unit_of_measure_custom_label    text,
  minimum_quantity                numeric(14, 3) check (minimum_quantity is null or minimum_quantity >= 0),
  suggested_reorder_quantity      numeric(14, 3) check (suggested_reorder_quantity is null or suggested_reorder_quantity >= 0),
  supplier                        text,
  supplier_part_number            text,
  cost                            numeric(12, 2) check (cost is null or cost >= 0),
  notes                           text,
  is_active                       boolean       not null default true,
  created_at                      timestamptz   not null default now(),
  updated_at                      timestamptz   not null default now(),
  created_by                      uuid          references auth.users(id) on delete set null,
  updated_by                      uuid          references auth.users(id) on delete set null,
  constraint maintenance_inventory_items_uom_custom_check check (
    (unit_of_measure = 'custom' and unit_of_measure_custom_label is not null and length(trim(unit_of_measure_custom_label)) > 0)
    or (unit_of_measure <> 'custom' and unit_of_measure_custom_label is null)
  )
);

create unique index maintenance_inventory_items_org_part_number_unique
  on public.maintenance_inventory_items (organization_id, part_number_normalized)
  where part_number is not null;

create index maintenance_inventory_items_org_location_idx
  on public.maintenance_inventory_items (organization_id, location_id);
create index maintenance_inventory_items_org_part_type_idx
  on public.maintenance_inventory_items (organization_id, part_type_id);
create index maintenance_inventory_items_org_active_qty_idx
  on public.maintenance_inventory_items (organization_id, is_active, quantity_on_hand);

alter table public.maintenance_inventory_items enable row level security;

create policy maintenance_inventory_items_select_org on public.maintenance_inventory_items
  for select to authenticated using (public.is_org_member(organization_id));
create policy maintenance_inventory_items_insert_org on public.maintenance_inventory_items
  for insert to authenticated with check (public.is_org_member(organization_id));
create policy maintenance_inventory_items_update_org on public.maintenance_inventory_items
  for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy maintenance_inventory_items_delete_org on public.maintenance_inventory_items
  for delete to authenticated using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.maintenance_inventory_items to service_role;

-- ============================================================
-- maintenance_inventory_transactions (immutable ledger)
-- ============================================================
-- related_restock_request_id / related_restock_line_id /
-- related_stock_count_session_id are left as bare uuid columns here (no FK
-- yet) because maintenance_restock_requests / _restock_request_lines /
-- _stock_count_sessions don't exist until 0130 — the FK constraints are
-- added there once the referenced tables exist.

create table public.maintenance_inventory_transactions (
  id                               uuid          primary key default gen_random_uuid(),
  organization_id                  uuid          not null references public.organizations(id) on delete cascade,
  item_id                          uuid          references public.maintenance_inventory_items(id) on delete set null,
  item_name_snapshot               text          not null,
  transaction_type                 text          not null check (transaction_type in ('receive', 'add', 'remove', 'manual_adjustment', 'stock_count_correction', 'restock_receipt')),
  quantity_before                  numeric(14, 3) not null,
  quantity_change                  numeric(14, 3) not null,
  quantity_after                   numeric(14, 3) not null,
  unit_snapshot                    text          not null,
  reason                           text,
  -- Client-generated (crypto.randomUUID()) idempotency key, resent unchanged
  -- on any retry of the same submission — identical pattern to
  -- pest_calibration_records.completion_request_id.
  request_id                       uuid          not null,
  performed_by                     uuid          references auth.users(id) on delete set null,
  performed_by_name_snapshot       text          not null,
  related_restock_request_id       uuid,
  related_restock_line_id          uuid,
  related_stock_count_session_id   uuid,
  created_at                       timestamptz   not null default now(),
  constraint maintenance_inventory_transactions_org_request_unique unique (organization_id, request_id)
);

create index maintenance_inventory_transactions_item_idx
  on public.maintenance_inventory_transactions (item_id, created_at desc, id desc);
create index maintenance_inventory_transactions_org_type_idx
  on public.maintenance_inventory_transactions (organization_id, transaction_type, created_at desc);
create index maintenance_inventory_transactions_restock_idx
  on public.maintenance_inventory_transactions (related_restock_request_id);
create index maintenance_inventory_transactions_session_idx
  on public.maintenance_inventory_transactions (related_stock_count_session_id);

alter table public.maintenance_inventory_transactions enable row level security;

create policy maintenance_inventory_transactions_select_org on public.maintenance_inventory_transactions
  for select to authenticated using (public.is_org_member(organization_id));
create policy maintenance_inventory_transactions_insert_org on public.maintenance_inventory_transactions
  for insert to authenticated with check (public.is_org_member(organization_id));

grant select, insert on table public.maintenance_inventory_transactions to service_role;

create trigger maintenance_inventory_transactions_immutable
  before update or delete on public.maintenance_inventory_transactions
  for each row execute function public.maintenance_prevent_mutation();

-- maintenance_apply_inventory_transaction: the single chokepoint every
-- quantity-changing flow goes through (manual receive/add/remove/adjust
-- from inventory.ts, restock receiving and stock-count corrections in
-- 0130). Client-submitted before/after totals are never trusted — this
-- function always locks the item row and reads the current value itself
-- before computing the new quantity.
--
-- Idempotency has two layers: (1) an up-front lookup of request_id, so a
-- retried call with the same request_id is a pure read (no lock, no write)
-- returning the original result with is_replay = true; (2) an
-- ON CONFLICT DO NOTHING on the insert itself as a belt-and-suspenders
-- guard against two truly concurrent calls with the same request_id both
-- passing step (1)'s check before either has inserted.
--
-- p_allow_negative exists only for a future/administrative corrective path;
-- every caller added in this project passes false, so a change that would
-- take quantity_on_hand below zero is always rejected.
create function public.maintenance_apply_inventory_transaction(
  p_organization_id uuid,
  p_item_id uuid,
  p_transaction_type text,
  p_quantity_change numeric,
  p_reason text,
  p_request_id uuid,
  p_performed_by uuid,
  p_performed_by_name text,
  p_related_restock_request_id uuid default null,
  p_related_restock_line_id uuid default null,
  p_related_stock_count_session_id uuid default null,
  p_allow_negative boolean default false
)
returns table (
  transaction_id uuid,
  quantity_before numeric,
  quantity_after numeric,
  is_replay boolean,
  item public.maintenance_inventory_items
)
language plpgsql
as $$
declare
  v_item public.maintenance_inventory_items;
  v_existing public.maintenance_inventory_transactions;
  v_new_qty numeric;
  v_txn public.maintenance_inventory_transactions;
begin
  select * into v_existing
  from public.maintenance_inventory_transactions
  where organization_id = p_organization_id and request_id = p_request_id;

  if v_existing.id is not null then
    select * into v_item from public.maintenance_inventory_items where id = p_item_id;
    return query select v_existing.id, v_existing.quantity_before, v_existing.quantity_after, true, v_item;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_item_id::text, 9));

  select * into v_item
  from public.maintenance_inventory_items
  where id = p_item_id and organization_id = p_organization_id
  for update;

  if v_item.id is null then
    raise exception 'Inventory item not found.' using errcode = 'P0002';
  end if;

  v_new_qty := v_item.quantity_on_hand + p_quantity_change;

  if v_new_qty < 0 and not p_allow_negative then
    raise exception 'This would result in a negative quantity (currently %, change %).', v_item.quantity_on_hand, p_quantity_change
      using errcode = '23514';
  end if;

  insert into public.maintenance_inventory_transactions (
    organization_id, item_id, item_name_snapshot, transaction_type, quantity_before, quantity_change, quantity_after,
    unit_snapshot, reason, request_id, performed_by, performed_by_name_snapshot,
    related_restock_request_id, related_restock_line_id, related_stock_count_session_id
  ) values (
    p_organization_id, p_item_id, v_item.name, p_transaction_type, v_item.quantity_on_hand, p_quantity_change, v_new_qty,
    coalesce(v_item.unit_of_measure_custom_label, v_item.unit_of_measure), p_reason, p_request_id, p_performed_by, p_performed_by_name,
    p_related_restock_request_id, p_related_restock_line_id, p_related_stock_count_session_id
  )
  on conflict (organization_id, request_id) do nothing
  returning * into v_txn;

  if v_txn.id is null then
    -- Lost the race to a truly-concurrent identical retry that inserted
    -- between our lookup above and this insert.
    select * into v_txn from public.maintenance_inventory_transactions
    where organization_id = p_organization_id and request_id = p_request_id;
    select * into v_item from public.maintenance_inventory_items where id = p_item_id;
    return query select v_txn.id, v_txn.quantity_before, v_txn.quantity_after, true, v_item;
    return;
  end if;

  update public.maintenance_inventory_items
  set quantity_on_hand = v_new_qty, updated_at = now(), updated_by = p_performed_by
  where id = p_item_id
  returning * into v_item;

  return query select v_txn.id, v_txn.quantity_before, v_txn.quantity_after, false, v_item;
end;
$$;

revoke execute on function public.maintenance_apply_inventory_transaction(
  uuid, uuid, text, numeric, text, uuid, uuid, text, uuid, uuid, uuid, boolean
) from public;
grant execute on function public.maintenance_apply_inventory_transaction(
  uuid, uuid, text, numeric, text, uuid, uuid, text, uuid, uuid, uuid, boolean
) to service_role;
