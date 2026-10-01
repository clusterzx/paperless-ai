/** Subset of the Paperless-ngx REST API objects we use (API v7 – v10). */

export interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
  /** Only present for API version < 10. */
  all?: number[];
}

export interface PaperlessDocument {
  id: number;
  title: string;
  content?: string;
  tags: number[];
  correspondent: number | null;
  document_type: number | null;
  storage_path?: number | null;
  /** Date ("YYYY-MM-DD") for API ≥ 9, datetime for older versions. */
  created: string | null;
  created_date?: string | null;
  modified?: string;
  added?: string;
  archive_serial_number?: number | null;
  original_file_name?: string | null;
  owner?: number | null;
  user_can_change?: boolean;
  custom_fields?: { field: number; value: unknown }[];
  mime_type?: string;
  notes?: unknown[];
}

export interface PaperlessTag {
  id: number;
  name: string;
  color?: string;
  text_color?: string;
  document_count?: number;
  is_inbox_tag?: boolean;
  parent?: number | null;
  matching_algorithm?: number;
}

export interface PaperlessCorrespondent {
  id: number;
  name: string;
  document_count?: number;
}

export interface PaperlessDocumentType {
  id: number;
  name: string;
  document_count?: number;
}

export type PaperlessCustomFieldType =
  | 'string'
  | 'url'
  | 'date'
  | 'boolean'
  | 'integer'
  | 'float'
  | 'monetary'
  | 'documentlink'
  | 'select'
  | 'longtext';

export interface PaperlessCustomField {
  id: number;
  name: string;
  data_type: PaperlessCustomFieldType;
  extra_data?: {
    default_currency?: string | null;
    select_options?: ({ id: string; label: string } | string)[];
  } | null;
  document_count?: number;
}

export interface PaperlessUiSettings {
  user: { id: number; username: string; is_staff?: boolean; is_superuser?: boolean; first_name?: string; last_name?: string };
  settings?: { version?: string; ai_enabled?: boolean } & Record<string, unknown>;
  permissions?: string[];
}

export interface PaperlessConnectionInfo {
  user: { id: number; username: string; isSuperuser: boolean };
  apiVersion: number;
  serverVersion: string | null;
  aiEnabled: boolean;
  permissions: string[];
}
