export interface WindowMetric {
  status?: string | null;
  percent?: number | null;
  resetsAt?: string | null;
}

export interface UsageData {
  rolling?: WindowMetric | null;
  weekly?: WindowMetric | null;
  monthly?: WindowMetric | null;
}

export interface ApiResponse {
  usage?: UsageData | null;
}

export interface AuthProviderEntry {
  type?: string | null;
  key?: string | null;
}

export interface AuthJson {
  "opencode-go"?: AuthProviderEntry | null;
}
