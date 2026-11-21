import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = path.resolve(process.env.DB_PATH || path.join(process.cwd(), 'data', 'panel.db'));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data', 'servers'));

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'mc'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'vm-backups'), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function columnExists(table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function addColumnIfMissing(table: string, column: string, definition: string): void {
  if (!columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Initial base tables (safe if already present)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('owner', 'admin', 'user')),
    is_suspended INTEGER NOT NULL DEFAULT 0,
    totp_secret TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    max_ram_mb INTEGER NOT NULL DEFAULT 8192,
    max_cpu_percent INTEGER NOT NULL DEFAULT 400,
    max_disk_gb INTEGER NOT NULL DEFAULT 50,
    max_mc_servers INTEGER NOT NULL DEFAULT 3,
    max_vm_instances INTEGER NOT NULL DEFAULT 2,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login TEXT
  );
`);

// Safely migrate older `users` table if its CHECK constraint only allowed ('owner', 'admin')
const usersTableMeta = db
  .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'`)
  .get() as { sql?: string } | undefined;

if (usersTableMeta?.sql && !usersTableMeta.sql.includes("'user'")) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE users_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('owner', 'admin', 'user')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended')),
        registration_ip TEXT NOT NULL DEFAULT '',
        is_suspended INTEGER NOT NULL DEFAULT 0,
        totp_secret TEXT,
        totp_enabled INTEGER NOT NULL DEFAULT 0,
        max_ram_mb INTEGER NOT NULL DEFAULT 8192,
        max_cpu_percent INTEGER NOT NULL DEFAULT 400,
        max_disk_gb INTEGER NOT NULL DEFAULT 50,
        max_mc_servers INTEGER NOT NULL DEFAULT 3,
        max_vm_instances INTEGER NOT NULL DEFAULT 2,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_login TEXT
      );
      INSERT INTO users_migrated (id, username, email, password_hash, role, created_at, last_login)
      SELECT id, username, email, password_hash, role, created_at, last_login FROM users;
      DROP TABLE users;
      ALTER TABLE users_migrated RENAME TO users;
    `);
  })();
  db.pragma('foreign_keys = ON');
} else {
  addColumnIfMissing('users', 'is_suspended', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('users', 'status', "TEXT NOT NULL DEFAULT 'active'");
  addColumnIfMissing('users', 'registration_ip', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing('users', 'totp_secret', 'TEXT');
  addColumnIfMissing('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('users', 'max_ram_mb', 'INTEGER NOT NULL DEFAULT 8192');
  addColumnIfMissing('users', 'max_cpu_percent', 'INTEGER NOT NULL DEFAULT 400');
  addColumnIfMissing('users', 'max_disk_gb', 'INTEGER NOT NULL DEFAULT 50');
  addColumnIfMissing('users', 'max_mc_servers', 'INTEGER NOT NULL DEFAULT 3');
  addColumnIfMissing('users', 'max_vm_instances', 'INTEGER NOT NULL DEFAULT 2');
}

// Keep status and is_suspended aligned for pre-existing rows
db.exec(`
  UPDATE users SET status = 'suspended' WHERE is_suspended = 1 AND status != 'suspended';
  UPDATE users SET is_suspended = 1 WHERE status = 'suspended' AND is_suspended = 0;
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT 'Local VPS',
    fqdn TEXT NOT NULL,
    daemon_port INTEGER NOT NULL DEFAULT 3000,
    token_prefix TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    is_local INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline')),
    cpu_percent REAL NOT NULL DEFAULT 0,
    ram_percent REAL NOT NULL DEFAULT 0,
    disk_percent REAL NOT NULL DEFAULT 0,
    active_servers INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS minecraft_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    container_name TEXT NOT NULL UNIQUE,
    container_id TEXT,
    software TEXT NOT NULL,
    version TEXT NOT NULL,
    ram_mb INTEGER NOT NULL,
    cpu_percent INTEGER NOT NULL,
    disk_mb INTEGER NOT NULL DEFAULT 10240,
    port INTEGER NOT NULL UNIQUE,
    eula_accepted INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'stopped',
    is_suspended INTEGER NOT NULL DEFAULT 0,
    owner_id INTEGER,
    node_id INTEGER NOT NULL DEFAULT 1,
    data_dir TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS vm_instances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    instance_name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK (type IN ('container', 'vm')),
    os_template TEXT NOT NULL,
    vcpu INTEGER NOT NULL,
    ram_mb INTEGER NOT NULL,
    disk_gb INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'stopped',
    is_suspended INTEGER NOT NULL DEFAULT 0,
    owner_id INTEGER,
    node_id INTEGER NOT NULL DEFAULT 1,
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS port_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_type TEXT NOT NULL CHECK (resource_type IN ('minecraft', 'incus')),
    resource_id INTEGER NOT NULL,
    host_port INTEGER NOT NULL,
    target_port INTEGER NOT NULL,
    protocol TEXT NOT NULL DEFAULT 'tcp' CHECK (protocol IN ('tcp', 'udp')),
    device_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(host_port, protocol)
  );

  CREATE TABLE IF NOT EXISTS port_pools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    start_port INTEGER NOT NULL,
    end_port INTEGER NOT NULL,
    protocol TEXT NOT NULL DEFAULT 'tcp' CHECK (protocol IN ('tcp', 'udp', 'both')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS minecraft_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    cron_expr TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('restart', 'backup', 'command')),
    payload TEXT NOT NULL DEFAULT '',
    retention_count INTEGER NOT NULL DEFAULT 7,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (server_id) REFERENCES minecraft_servers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS minecraft_backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    filename TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    backup_type TEXT NOT NULL DEFAULT 'manual' CHECK (backup_type IN ('manual', 'scheduled', 'pre_restore')),
    cloud_provider TEXT NOT NULL DEFAULT 'local',
    cloud_key TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT 'system',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (server_id) REFERENCES minecraft_servers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS incus_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    cron_expr TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT 'snapshot' CHECK (action IN ('snapshot', 'local_backup')),
    retention_count INTEGER NOT NULL DEFAULT 7,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (instance_id) REFERENCES vm_instances(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS incus_backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    backup_kind TEXT NOT NULL DEFAULT 'snapshot' CHECK (backup_kind IN ('snapshot', 'archive')),
    archive_filename TEXT,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    backup_type TEXT NOT NULL DEFAULT 'manual' CHECK (backup_type IN ('manual', 'scheduled', 'pre_restore')),
    cloud_provider TEXT NOT NULL DEFAULT 'local',
    cloud_key TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT 'system',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (instance_id) REFERENCES vm_instances(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS server_subusers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    can_start_stop INTEGER NOT NULL DEFAULT 1,
    can_use_console INTEGER NOT NULL DEFAULT 1,
    can_edit_files INTEGER NOT NULL DEFAULT 0,
    can_manage_backups INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(server_id, user_id),
    FOREIGN KEY (server_id) REFERENCES minecraft_servers(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reverse_proxies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id INTEGER NOT NULL,
    domain TEXT NOT NULL UNIQUE,
    target_port INTEGER NOT NULL,
    ssl_enabled INTEGER NOT NULL DEFAULT 1,
    engine TEXT NOT NULL DEFAULT 'caddy' CHECK (engine IN ('caddy', 'nginx')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (instance_id) REFERENCES vm_instances(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    details TEXT,
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Add new columns cleanly to pre-existing tables
addColumnIfMissing('minecraft_servers', 'owner_id', 'INTEGER');
addColumnIfMissing('minecraft_servers', 'is_suspended', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('minecraft_servers', 'disk_mb', 'INTEGER NOT NULL DEFAULT 10240');
addColumnIfMissing('minecraft_servers', 'node_id', 'INTEGER NOT NULL DEFAULT 1');
addColumnIfMissing('minecraft_schedules', 'retention_count', 'INTEGER NOT NULL DEFAULT 7');
addColumnIfMissing('minecraft_backups', 'cloud_provider', "TEXT NOT NULL DEFAULT 'local'");
addColumnIfMissing('minecraft_backups', 'cloud_key', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('vm_instances', 'owner_id', 'INTEGER');
addColumnIfMissing('vm_instances', 'is_suspended', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('vm_instances', 'node_id', 'INTEGER NOT NULL DEFAULT 1');
addColumnIfMissing('incus_backups', 'cloud_provider', "TEXT NOT NULL DEFAULT 'local'");
addColumnIfMissing('incus_backups', 'cloud_key', "TEXT NOT NULL DEFAULT ''");

// Ensure Primary Local Node #1 exists
const localNodeCount = db
  .prepare('SELECT COUNT(*) AS count FROM nodes WHERE is_local = 1')
  .get() as { count: number };
if (localNodeCount.count === 0) {
  db.prepare(
    `INSERT INTO nodes (id, name, location, fqdn, daemon_port, token_prefix, token_hash, is_local, status, last_seen_at)
     VALUES (1, 'Primary Node #1', 'Local VPS Host', '127.0.0.1', 3000, 'local_primary', 'local_primary_node', 1, 'online', datetime('now'))`
  ).run();
}
db.exec(`
  UPDATE minecraft_servers SET node_id = 1 WHERE node_id IS NULL;
  UPDATE vm_instances SET node_id = 1 WHERE node_id IS NULL;
`);

// Backfill owner_id to first owner if NULL
const firstOwner = db
  .prepare(`SELECT id FROM users WHERE role = 'owner' ORDER BY id ASC LIMIT 1`)
  .get() as { id: number } | undefined;
if (firstOwner) {
  db.prepare(`UPDATE minecraft_servers SET owner_id = ? WHERE owner_id IS NULL`).run(firstOwner.id);
  db.prepare(`UPDATE vm_instances SET owner_id = ? WHERE owner_id IS NULL`).run(firstOwner.id);
}

// Seed default global port pool if none exist
const poolCount = db.prepare('SELECT COUNT(*) AS count FROM port_pools').get() as { count: number };
if (poolCount.count === 0) {
  db.prepare(
    `INSERT INTO port_pools (label, start_port, end_port, protocol) VALUES (?, ?, ?, ?)`
  ).run('Default Minecraft Range', 25565, 25650, 'tcp');
}

const defaultSettings: Array<[string, string]> = [
  ['panel_name', 'FB BAHI Panel'],
  ['panel_subtitle', 'Game Server & Cloud VM Control'],
  ['discord_webhook_url', ''],
  ['webhook_on_start', '1'],
  ['webhook_on_stop', '1'],
  ['webhook_on_crash', '1'],
  ['telegram_bot_token', ''],
  ['telegram_chat_id', ''],
  ['allow_public_registration', '1'],
  ['registration_mode', 'approval'],
  ['cloud_provider', 'none'],
  ['cloud_endpoint', ''],
  ['cloud_region', 'auto'],
  ['cloud_bucket', ''],
  ['cloud_access_key', ''],
  ['cloud_secret_key', ''],
  ['cloud_rclone_remote', ''],
  ['cloud_rclone_folder', 'fbbahi-backups'],
  ['cloud_auto_upload', '0'],
  ['maintenance_mode', '0'],
  ['maintenance_message', 'FB BAHI Panel is undergoing scheduled maintenance. Please check back shortly.'],
  ['announcement_enabled', '0'],
  ['announcement_level', 'info'],
  ['announcement_text', ''],
  ['smtp_host', ''],
  ['smtp_port', '587'],
  ['smtp_user', ''],
  ['smtp_pass', ''],
  ['smtp_from', ''],
  ['vps_reboot_warning', ''],
];

const insertSettingStmt = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
);

for (const [key, val] of defaultSettings) {
  insertSettingStmt.run(key, val);
}

export function getDataDir(): string {
  return dataDir;
}

export function getDbPath(): string {
  return dbPath;
}

export function getAllSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.key] = row.value;
  }
  return map;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, value);
}

export function recordAuditLog(params: {
  userId?: number | null;
  username: string;
  action: string;
  target: string;
  details?: string;
  ipAddress?: string;
}): void {
  db.prepare(
    `INSERT INTO audit_logs (user_id, username, action, target, details, ip_address)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    params.userId ?? null,
    params.username,
    params.action,
    params.target,
    params.details ?? '',
    params.ipAddress ?? ''
  );
}
