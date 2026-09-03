CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  name          text NOT NULL,
  is_admin      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- id is the SHA-256 of the session token; the raw token is never stored.
CREATE TABLE sessions (
  id         text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE groups (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE group_members (
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user ON group_members (user_id);

CREATE TABLE spaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE subject_kind AS ENUM ('user', 'group');

CREATE TABLE space_members (
  space_id     uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  subject_type subject_kind NOT NULL,
  subject_id   uuid NOT NULL,
  role         smallint NOT NULL CHECK (role BETWEEN 1 AND 3),
  PRIMARY KEY (space_id, subject_type, subject_id)
);

CREATE TABLE storage_backends (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  provider        text NOT NULL DEFAULT 's3',
  config          bytea NOT NULL,          -- pgp_sym_encrypt of a JSON blob
  is_write_target boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- At most one write target. Forces setWriteTarget to clear before it sets.
CREATE UNIQUE INDEX storage_one_write_target
  ON storage_backends ((true)) WHERE is_write_target;

CREATE TABLE items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id           uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  parent_id          uuid REFERENCES items(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('folder','file')),
  name               text NOT NULL,
  -- every ancestor id from root, PLUS this item's own id
  path_ids           uuid[] NOT NULL,
  size               bigint,
  mime               text,
  storage_backend_id uuid REFERENCES storage_backends(id),
  storage_key        text,
  status             text NOT NULL DEFAULT 'ready' CHECK (status IN ('pending','ready')),
  deleted_at         timestamptz,
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX items_path_ids ON items USING GIN (path_ids);
CREATE INDEX items_parent   ON items (parent_id) WHERE deleted_at IS NULL;
CREATE INDEX items_space    ON items (space_id)  WHERE deleted_at IS NULL;
CREATE INDEX items_pending  ON items (created_at) WHERE status = 'pending';
CREATE INDEX items_trashed  ON items (deleted_at) WHERE deleted_at IS NOT NULL;

-- No two live siblings with the same name (case-insensitive).
CREATE UNIQUE INDEX items_sibling_name ON items (
  space_id,
  COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
  lower(name)
) WHERE deleted_at IS NULL;

CREATE TABLE item_grants (
  item_id      uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  subject_type subject_kind NOT NULL,
  subject_id   uuid NOT NULL,
  role         smallint NOT NULL CHECK (role BETWEEN 1 AND 3),
  PRIMARY KEY (item_id, subject_type, subject_id)
);

CREATE TABLE share_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text UNIQUE NOT NULL,     -- SHA-256; raw token shown once
  item_id       uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  mode          text NOT NULL CHECK (mode IN ('view','download')),
  password_hash text,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX share_links_item ON share_links (item_id);
