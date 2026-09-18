-- Maintenance module — Restock requests and stock-count sessions.
--
-- Both flows are read-mostly config tables (requests/sessions + their line
-- items) plus one RPC each that's the only path allowed to actually move
-- inventory quantity — both RPCs delegate to
-- maintenance_apply_inventory_transaction (0129) rather than touching
-- quantity_on_hand directly, so the ledger and the cached quantity can never
-- drift apart regardless of which flow changed them.

-- ============================================================
-- maintenance_restock_requests / _restock_request_lines
-- ============================================================

create table public.maintenance_restock_requests (
  id                          uuid        primary key default gen_random_uuid(),
  organization_id             uuid        not null references public.organizations(id) on delete cascade,
  status                      text        not null default 'requested' check (status in ('requested', 'ordered', 'partially_received', 'received', 'cancelled')),
  notes                       text,
  requested_by                uuid        references auth.users(id) on delete set null,
  requested_by_name_snapshot  text        not null,
  ordered_at                  timestamptz,
  cancelled_at                timestamptz,
  cancelled_by                uuid        references auth.users(id) on delete set null,
  cancelled_reason            text,
  completed_at                timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index maintenance_restock_requests_org_status_idx
  on public.maintenance_restock_requests (organization_id, status, created_at desc);

alter table public.maintenance_restock_requests enable row level security;

create policy maintenance_restock_requests_select_org on public.maintenance_restock_requests
  for select to authenticated using (public.is_org_member(organization_id));
create policy maintenance_restock_requests_insert_org on public.maintenance_restock_requests
  for insert to authenticated with check (public.is_org_member(organization_id));
create policy maintenance_restock_requests_update_org on public.maintenance_restock_requests
  for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy maintenance_restock_requests_delete_org on public.maintenance_restock_requests
  for delete to authenticated using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.maintenance_restock_requests to service_role;

create table public.maintenance_restock_request_lines (
  id                    uuid        primary key default gen_random_uuid(),
  organization_id       uuid        not null references public.organizations(id) on delete cascade,
  request_id            uuid        not null references public.maintenance_restock_requests(id) on delete cascade,
  item_id               uuid        references public.maintenance_inventory_items(id) on delete set null,
  item_name_snapshot    text        not null,
  unit_snapshot         text        not null,
  requested_quantity    numeric(14, 3) not null check (requested_quantity > 0),
  received_quantity     numeric(14, 3) not null default 0 check (received_quantity >= 0),
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- This constraint alone is most of what prevents "receiving the same
  -- quantity twice": a receive that would push received_quantity above
  -- requested_quantity is rejected by Postgres, not just application logic.
  constraint maintenance_restock_request_lines_received_le_requested check (received_quantity <= requested_quantity)
);

create index maintenance_restock_request_lines_request_idx
  on public.maintenance_restock_request_lines (request_id);

alter table public.maintenance_restock_request_lines enable row level security;

create policy maintenance_restock_request_lines_select_org on public.maintenance_restock_request_lines
  for select to authenticated using (public.is_org_member(organization_id));
create policy maintenance_restock_request_lines_insert_org on public.maintenance_restock_request_lines
  for insert to authenticated with check (public.is_org_member(organization_id));
create policy maintenance_restock_request_lines_update_org on public.maintenance_restock_request_lines
  for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy maintenance_restock_request_lines_delete_org on public.maintenance_restock_request_lines
  for delete to authenticated using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.maintenance_restock_request_lines to service_role;

-- maintenance_receive_restock_line: locks the line, validates the receive
-- amount against what's left to receive, applies the inventory change
-- through maintenance_apply_inventory_transaction (type='restock_receipt'),
-- and — only when that call's is_replay is false — bumps the line's
-- received_quantity and recomputes the parent request's status. Skipping
-- the bookkeeping on a replay is what makes a retried receive request safe:
-- the ledger/quantity side is already a no-op via maintenance_apply_
-- inventory_transaction's own idempotency, and without this check a retry
-- would otherwise double-count received_quantity even though no new stock
-- actually moved.
create function public.maintenance_receive_restock_line(
  p_organization_id uuid,
  p_request_id uuid,
  p_line_id uuid,
  p_receive_quantity numeric,
  p_ledger_request_id uuid,
  p_performed_by uuid,
  p_performed_by_name text
)
returns table (line public.maintenance_restock_request_lines, request_status text)
language plpgsql
as $$
declare
  v_line public.maintenance_restock_request_lines;
  v_remaining numeric;
  v_txn_is_replay boolean;
  v_request_status text;
  v_all_received boolean;
  v_any_received boolean;
begin
  if p_receive_quantity <= 0 then
    raise exception 'Receive quantity must be greater than zero.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_line_id::text, 11));

  select * into v_line
  from public.maintenance_restock_request_lines
  where id = p_line_id and request_id = p_request_id and organization_id = p_organization_id
  for update;

  if v_line.id is null then
    raise exception 'Restock request line not found.' using errcode = 'P0002';
  end if;

  v_remaining := v_line.requested_quantity - v_line.received_quantity;

  if p_receive_quantity > v_remaining then
    raise exception 'Cannot receive % — only % remains on this line.', p_receive_quantity, v_remaining
      using errcode = '23514';
  end if;

  select is_replay into v_txn_is_replay
  from public.maintenance_apply_inventory_transaction(
    p_organization_id, v_line.item_id, 'restock_receipt', p_receive_quantity,
    'Restock request ' || p_request_id, p_ledger_request_id, p_performed_by, p_performed_by_name,
    p_request_id, p_line_id, null, false
  );

  if not v_txn_is_replay then
    update public.maintenance_restock_request_lines
    set received_quantity = received_quantity + p_receive_quantity, updated_at = now()
    where id = p_line_id
    returning * into v_line;

    select
      bool_and(received_quantity >= requested_quantity),
      bool_or(received_quantity > 0)
    into v_all_received, v_any_received
    from public.maintenance_restock_request_lines
    where request_id = p_request_id;

    v_request_status := case when v_all_received then 'received' when v_any_received then 'partially_received' else 'requested' end;

    update public.maintenance_restock_requests
    set status = v_request_status,
        completed_at = case when v_request_status = 'received' then now() else completed_at end,
        updated_at = now()
    where id = p_request_id and status not in ('cancelled');
  else
    select status into v_request_status from public.maintenance_restock_requests where id = p_request_id;
  end if;

  return query select v_line, v_request_status;
end;
$$;

revoke execute on function public.maintenance_receive_restock_line(uuid, uuid, uuid, numeric, uuid, uuid, text) from public;
grant execute on function public.maintenance_receive_restock_line(uuid, uuid, uuid, numeric, uuid, uuid, text) to service_role;

-- ============================================================
-- maintenance_stock_count_sessions / _stock_count_lines
-- ============================================================

create table public.maintenance_stock_count_sessions (
  id                        uuid        primary key default gen_random_uuid(),
  organization_id           uuid        not null references public.organizations(id) on delete cascade,
  location_id               uuid        references public.maintenance_locations(id) on delete set null,
  location_name_snapshot    text        not null,
  status                    text        not null default 'draft' check (status in ('draft', 'confirmed', 'cancelled')),
  started_by                uuid        references auth.users(id) on delete set null,
  started_by_name_snapshot  text        not null,
  started_at                timestamptz not null default now(),
  confirmed_at              timestamptz,
  confirmed_by              uuid        references auth.users(id) on delete set null,
  cancelled_at              timestamptz,
  cancelled_by              uuid        references auth.users(id) on delete set null,
  cancelled_reason          text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index maintenance_stock_count_sessions_org_status_idx
  on public.maintenance_stock_count_sessions (organization_id, status);

alter table public.maintenance_stock_count_sessions enable row level security;

create policy maintenance_stock_count_sessions_select_org on public.maintenance_stock_count_sessions
  for select to authenticated using (public.is_org_member(organization_id));
create policy maintenance_stock_count_sessions_insert_org on public.maintenance_stock_count_sessions
  for insert to authenticated with check (public.is_org_member(organization_id));
create policy maintenance_stock_count_sessions_update_org on public.maintenance_stock_count_sessions
  for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy maintenance_stock_count_sessions_delete_org on public.maintenance_stock_count_sessions
  for delete to authenticated using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.maintenance_stock_count_sessions to service_role;

create table public.maintenance_stock_count_lines (
  id                             uuid        primary key default gen_random_uuid(),
  organization_id                uuid        not null references public.organizations(id) on delete cascade,
  session_id                     uuid        not null references public.maintenance_stock_count_sessions(id) on delete cascade,
  item_id                        uuid        references public.maintenance_inventory_items(id) on delete set null,
  item_name_snapshot              text        not null,
  unit_snapshot                   text        not null,
  expected_quantity               numeric(14, 3) not null,
  -- Conflict-detection marker: the id of the item's most-recent ledger
  -- transaction at the moment this line was created. Re-checked at confirm
  -- time (see maintenance_confirm_stock_count_session) — if it no longer
  -- matches the item's current most-recent transaction, something else
  -- changed that item's quantity after the snapshot was taken, and the line
  -- is reported as a conflict rather than silently overwritten. Simpler and
  -- clock-skew-immune compared to a timestamp-window comparison.
  expected_last_transaction_id    uuid        references public.maintenance_inventory_transactions(id) on delete set null,
  counted_quantity                 numeric(14, 3) check (counted_quantity is null or counted_quantity >= 0),
  counted_at                       timestamptz,
  counted_by                       uuid        references auth.users(id) on delete set null,
  notes                            text,
  created_at                       timestamptz not null default now(),
  updated_at                       timestamptz not null default now()
);

create index maintenance_stock_count_lines_session_idx
  on public.maintenance_stock_count_lines (session_id);

alter table public.maintenance_stock_count_lines enable row level security;

create policy maintenance_stock_count_lines_select_org on public.maintenance_stock_count_lines
  for select to authenticated using (public.is_org_member(organization_id));
create policy maintenance_stock_count_lines_insert_org on public.maintenance_stock_count_lines
  for insert to authenticated with check (public.is_org_member(organization_id));
create policy maintenance_stock_count_lines_update_org on public.maintenance_stock_count_lines
  for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy maintenance_stock_count_lines_delete_org on public.maintenance_stock_count_lines
  for delete to authenticated using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.maintenance_stock_count_lines to service_role;

-- Guard trigger: once a session is no longer 'draft', its lines become
-- immutable (a confirmed session must never be silently re-edited; a
-- cancelled one has no reason to be). Unlike the fully-immutable-forever
-- tables above, this is conditional on session state rather than absolute,
-- so it's a bespoke trigger rather than maintenance_prevent_mutation().
create function public.maintenance_stock_count_lines_guard()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  select status into v_status
  from public.maintenance_stock_count_sessions
  where id = coalesce(new.session_id, old.session_id);

  if v_status is distinct from 'draft' then
    raise exception 'This stock count session is % and its lines can no longer be edited.', v_status
      using errcode = '42501';
  end if;

  return coalesce(new, old);
end;
$$;

create trigger maintenance_stock_count_lines_guard_trigger
  before update or delete on public.maintenance_stock_count_lines
  for each row execute function public.maintenance_stock_count_lines_guard();

-- maintenance_create_stock_count_session: inserts the session, then
-- bulk-inserts one line per active item at the chosen location in the same
-- transaction (snapshotting expected_quantity and
-- expected_last_transaction_id per item) — a mid-batch failure can't leave
-- a session with only some of its lines populated.
create function public.maintenance_create_stock_count_session(
  p_organization_id uuid,
  p_location_id uuid,
  p_location_name text,
  p_started_by uuid,
  p_started_by_name text
)
returns public.maintenance_stock_count_sessions
language plpgsql
as $$
declare
  v_session public.maintenance_stock_count_sessions;
begin
  insert into public.maintenance_stock_count_sessions (
    organization_id, location_id, location_name_snapshot, started_by, started_by_name_snapshot
  ) values (
    p_organization_id, p_location_id, p_location_name, p_started_by, p_started_by_name
  )
  returning * into v_session;

  insert into public.maintenance_stock_count_lines (
    organization_id, session_id, item_id, item_name_snapshot, unit_snapshot,
    expected_quantity, expected_last_transaction_id
  )
  select
    p_organization_id,
    v_session.id,
    i.id,
    i.name,
    coalesce(i.unit_of_measure_custom_label, i.unit_of_measure),
    i.quantity_on_hand,
    (
      select t.id from public.maintenance_inventory_transactions t
      where t.item_id = i.id
      order by t.created_at desc, t.id desc
      limit 1
    )
  from public.maintenance_inventory_items i
  where i.organization_id = p_organization_id
    and i.location_id = p_location_id
    and i.is_active = true;

  return v_session;
end;
$$;

revoke execute on function public.maintenance_create_stock_count_session(uuid, uuid, text, uuid, text) from public;
grant execute on function public.maintenance_create_stock_count_session(uuid, uuid, text, uuid, text) to service_role;

-- maintenance_confirm_stock_count_session: idempotent via a
-- status = 'confirmed' early-return (a retried confirm call is always a
-- safe no-op, so no separate request-id column is needed on the session
-- itself — unlike the ledger/schedule-completion RPCs, which need one
-- because their side effects aren't naturally idempotent on their own).
-- Row-locks the session, re-checks every line's current latest-ledger-
-- transaction-id against its snapshot; ANY mismatch aborts the whole
-- confirm with a structured CONFLICT:<json> exception (parsed by the route
-- handler into a 409 naming the specific conflicting lines) rather than
-- silently overwriting newer transactions. If clean, applies one
-- maintenance_apply_inventory_transaction call per line whose
-- counted_quantity differs from expected_quantity.
create function public.maintenance_confirm_stock_count_session(
  p_organization_id uuid,
  p_session_id uuid,
  p_confirmed_by uuid,
  p_confirmed_by_name text
)
returns public.maintenance_stock_count_sessions
language plpgsql
as $$
declare
  v_session public.maintenance_stock_count_sessions;
  v_line record;
  v_latest uuid;
  v_conflicts jsonb := '[]'::jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 10));

  select * into v_session
  from public.maintenance_stock_count_sessions
  where id = p_session_id and organization_id = p_organization_id
  for update;

  if v_session.id is null then
    raise exception 'Stock count session not found.' using errcode = 'P0002';
  end if;

  if v_session.status = 'confirmed' then
    return v_session; -- idempotent replay
  end if;

  if v_session.status = 'cancelled' then
    raise exception 'This stock count session was cancelled.' using errcode = '22023';
  end if;

  for v_line in select * from public.maintenance_stock_count_lines where session_id = p_session_id loop
    if v_line.counted_quantity is null then
      v_conflicts := v_conflicts || jsonb_build_object('line_id', v_line.id, 'reason', 'not_counted');
      continue;
    end if;

    select t.id into v_latest
    from public.maintenance_inventory_transactions t
    where t.item_id = v_line.item_id
    order by t.created_at desc, t.id desc
    limit 1;

    if v_latest is distinct from v_line.expected_last_transaction_id then
      v_conflicts := v_conflicts || jsonb_build_object('line_id', v_line.id, 'reason', 'inventory_changed_since_snapshot');
    end if;
  end loop;

  if jsonb_array_length(v_conflicts) > 0 then
    raise exception 'CONFLICT:%', v_conflicts::text using errcode = '40001';
  end if;

  for v_line in select * from public.maintenance_stock_count_lines where session_id = p_session_id loop
    if v_line.counted_quantity <> v_line.expected_quantity then
      perform public.maintenance_apply_inventory_transaction(
        p_organization_id, v_line.item_id, 'stock_count_correction', v_line.counted_quantity - v_line.expected_quantity,
        'Stock count session ' || p_session_id, gen_random_uuid(), p_confirmed_by, p_confirmed_by_name,
        null, null, p_session_id, false
      );
    end if;
  end loop;

  update public.maintenance_stock_count_sessions
  set status = 'confirmed', confirmed_at = now(), confirmed_by = p_confirmed_by, updated_at = now()
  where id = p_session_id
  returning * into v_session;

  return v_session;
end;
$$;

revoke execute on function public.maintenance_confirm_stock_count_session(uuid, uuid, uuid, text) from public;
grant execute on function public.maintenance_confirm_stock_count_session(uuid, uuid, uuid, text) to service_role;

-- ============================================================
-- Link the ledger's related_* columns now that their target tables exist
-- ============================================================

alter table public.maintenance_inventory_transactions
  add constraint maintenance_inventory_transactions_restock_request_fk
    foreign key (related_restock_request_id) references public.maintenance_restock_requests(id) on delete set null,
  add constraint maintenance_inventory_transactions_restock_line_fk
    foreign key (related_restock_line_id) references public.maintenance_restock_request_lines(id) on delete set null,
  add constraint maintenance_inventory_transactions_session_fk
    foreign key (related_stock_count_session_id) references public.maintenance_stock_count_sessions(id) on delete set null;
