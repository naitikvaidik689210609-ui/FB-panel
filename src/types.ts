export type UserRole = 'owner' | 'admin' | 'user';

export interface AuthUser {
  id: number;
  username: string;
  email: string;
  role: UserRole;
  status?: 'pending' | 'active' | 'suspended';
  registration_ip?: string | null;
  totp_enabled?: number;
  is_suspended?: number;
  impersonatedBy?: {
    id: number;
    username: string;
  };
  created_at?: string;
  last_login?: string | null;
}

export interface UserQuotaSummary {
  limits: {
    maxRamMb: number;
    maxCpuPercent: number;
    maxDiskGb: number;
    maxMcServers: number;
    maxVmInstances: number;
  };
  used: {
    ramMb: number;
    cpuPercent: number;
    diskGb: number;
    mcServers: number;
    vmInstances: number;
  };
}

export interface ManagedUser extends AuthUser {
  status?: 'pending' | 'active' | 'suspended';
  registration_ip?: string | null;
  is_suspended: number;
  totp_enabled: number;
  max_ram_mb: number;
  max_cpu_percent: number;
  max_disk_gb: number;
  max_mc_servers: number;
  max_vm_instances: number;
  quota: UserQuotaSummary;
}

export interface NodeItem {
  id: number;
  name: string;
  location: string;
  fqdn: string;
  daemon_port: number;
  token_prefix: string;
  is_local: number;
  status: 'online' | 'offline';
  cpu_percent: number;
  ram_percent: number;
  disk_percent: number;
  active_servers: number;
  last_seen_at: string | null;
  workload_count: number;
  created_at: string;
}

export interface PanelBranding {
  panelName: string;
  panelSubtitle: string;
}

export interface AnnouncementConfig {
  enabled: boolean;
  level: 'info' | 'warning' | 'critical';
  text: string;
}

export interface HostCapabilities {
  dockerAvailable: boolean;
  incusAvailable: boolean;
  hostname: string;
  platform: string;
  arch: string;
  kernel: string;
  cpuCores: number;
}

export interface LiveSystemStats {
  timestamp: number;
  cpuPercent: number;
  cpuCores: number;
  loadAvg: number[];
  memory: {
    totalBytes: number;
    usedBytes: number;
    percent: number;
  };
  disk: {
    totalBytes: number;
    usedBytes: number;
    percent: number;
  };
  network: {
    rxBytesPerSec: number;
    txBytesPerSec: number;
    totalRxBytes: number;
    totalTxBytes: number;
  };
  uptimeSeconds: number;
  counts: {
    minecraftTotal: number;
    minecraftRunning: number;
    vmTotal: number;
    vmRunning: number;
    activeTotal: number;
  };
}

export interface MinecraftServer {
  id: number;
  name: string;
  container_name: string;
  container_id: string | null;
  software: string;
  version: string;
  ram_mb: number;
  cpu_percent: number;
  disk_mb: number;
  port: number;
  eula_accepted: number;
  status: string;
  is_suspended: number;
  owner_id: number | null;
  owner_username?: string;
  node_id?: number;
  node_name?: string;
  node_location?: string;
  data_dir: string;
  created_at: string;
}

export interface ScheduleItem {
  id: number;
  server_id: number;
  server_name?: string;
  name: string;
  cron_expr: string;
  action: 'restart' | 'backup' | 'command';
  payload: string;
  retention_count?: number;
  enabled: number;
  last_run_at: string | null;
  created_at: string;
}

export interface MinecraftBackupItem {
  id: number;
  server_id: number;
  server_name?: string;
  container_name?: string;
  name: string;
  filename: string;
  size_bytes: number;
  backup_type: 'manual' | 'scheduled' | 'pre_restore';
  created_by: string;
  created_at: string;
  cloud_provider?: string;
  cloud_key?: string;
  exists_on_disk?: boolean;
}

export interface IncusBackupItem {
  id: number;
  instance_id: number;
  instance_display_name?: string;
  instance_name?: string;
  instance_type?: 'container' | 'vm';
  name: string;
  backup_kind: 'snapshot' | 'archive';
  archive_filename: string | null;
  size_bytes: number;
  backup_type: 'manual' | 'scheduled' | 'pre_restore';
  created_by: string;
  created_at: string;
  cloud_provider?: string;
  cloud_key?: string;
  exists_on_disk?: boolean;
}

export interface IncusScheduleItem {
  id: number;
  instance_id: number;
  instance_display_name?: string;
  instance_type?: 'container' | 'vm';
  name: string;
  cron_expr: string;
  action: 'snapshot' | 'local_backup';
  retention_count: number;
  enabled: number;
  last_run_at: string | null;
  created_at: string;
}

export interface UnifiedBackupsSummary {
  mcBackups: MinecraftBackupItem[];
  incusBackups: IncusBackupItem[];
  mcSchedules: ScheduleItem[];
  incusSchedules: IncusScheduleItem[];
}

export interface SubUserItem {
  id: number;
  server_id: number;
  user_id: number;
  username: string;
  email: string;
  can_start_stop: number;
  can_use_console: number;
  can_edit_files: number;
  can_manage_backups: number;
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

export interface ModrinthHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  icon_url: string;
  project_type: string;
  categories: string[];
}

export interface VmInstance {
  id: number;
  name: string;
  instance_name: string;
  type: 'container' | 'vm';
  os_template: string;
  vcpu: number;
  ram_mb: number;
  disk_gb: number;
  status: string;
  is_suspended: number;
  owner_id: number | null;
  owner_username?: string;
  node_id?: number;
  node_name?: string;
  node_location?: string;
  ip_address: string | null;
  created_at: string;
}

export interface SnapshotItem {
  name: string;
  created_at: string;
  stateful: boolean;
}

export interface PortAllocation {
  id: number;
  resource_type: string;
  resource_id: number;
  host_port: number;
  target_port: number;
  protocol: 'tcp' | 'udp';
  device_name: string;
  created_at: string;
}

export interface ReverseProxyItem {
  id: number;
  instance_id: number;
  domain: string;
  target_port: number;
  ssl_enabled: number;
  engine: 'caddy' | 'nginx';
  configPreview: string;
  created_at: string;
}

export interface ApiKeyItem {
  id: number;
  name: string;
  key_prefix: string;
  last_used_at: string | null;
  created_at: string;
  username: string;
}

export interface PortPoolItem {
  id: number;
  label: string;
  start_port: number;
  end_port: number;
  protocol: 'tcp' | 'udp' | 'both';
  created_at: string;
}

export interface AuditLog {
  id: number;
  user_id: number | null;
  username: string;
  action: string;
  target: string;
  details: string;
  ip_address: string;
  created_at: string;
}

export interface PanelSettings {
  panel_name: string;
  panel_subtitle: string;
  discord_webhook_url: string;
  webhook_on_start: string;
  webhook_on_stop: string;
  webhook_on_crash: string;
  maintenance_mode?: string;
  maintenance_message?: string;
  announcement_enabled?: string;
  announcement_level?: string;
  announcement_text?: string;
  smtp_host?: string;
  smtp_port?: string;
  smtp_user?: string;
  smtp_pass?: string;
  smtp_from?: string;
  vps_reboot_warning?: string;
  allow_public_registration?: string;
  registration_mode?: 'instant' | 'approval' | string;
  telegram_bot_token?: string;
  telegram_chat_id?: string;
  cloud_provider?: 'none' | 's3' | 'r2' | 'b2' | 'gdrive' | string;
  cloud_endpoint?: string;
  cloud_region?: string;
  cloud_bucket?: string;
  cloud_access_key?: string;
  cloud_secret_key?: string;
  cloud_rclone_remote?: string;
  cloud_rclone_folder?: string;
  cloud_auto_upload?: string;
}

export interface GlobalSearchResults {
  servers: Array<{ id: number; name: string; software: string; version: string; port: number; status: string }>;
  instances: Array<{ id: number; name: string; instance_name: string; type: string; os_template: string; status: string }>;
  users: Array<{ id: number; username: string; email: string; role: UserRole }>;
}
