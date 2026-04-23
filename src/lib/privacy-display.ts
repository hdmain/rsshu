/** Host fields used to strip identifying text from UI and connection logs. */
export type PrivacyHostRef = {
  name: string;
  host: string;
  port: number;
  username: string;
};

const IPV4_CHUNK = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d{1,3})\.){3}(?:25[0-5]|2[0-4]\d|1?\d{1,3})(?::\d{1,5})?\b/g;

function hasIpv4(s: string): boolean {
  return /\b(?:(?:25[0-5]|2[0-4]\d|1?\d{1,3})\.){3}(?:25[0-5]|2[0-4]\d|1?\d{1,3})\b/.test(s);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectPhrases(hosts: PrivacyHostRef[]): string[] {
  const out: string[] = [];
  for (const h of hosts) {
    if (h.host.length >= 2) out.push(h.host);
    if (h.name.length >= 2) out.push(h.name);
    out.push(`${h.username}@${h.host}`);
    out.push(`${h.host}:${h.port}`);
    out.push(`${h.username}@${h.host}:${h.port}`);
  }
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

/** Redact IPs and known host strings from arbitrary text (e.g. SSH progress lines from the backend). */
export function redactConnectionLogLine(line: string, hosts: PrivacyHostRef[], enabled: boolean): string {
  if (!enabled) return line;
  let text = line;
  for (const phrase of collectPhrases(hosts)) {
    text = text.replace(new RegExp(escapeRegExp(phrase), "g"), "[redacted]");
  }
  text = text.replace(IPV4_CHUNK, "[IPv4]");
  return text;
}

export function hostCardTitle(host: PrivacyHostRef, privacy: boolean): string {
  if (!privacy) return host.name;
  if (hasIpv4(host.name) || host.name.trim().toLowerCase() === host.host.trim().toLowerCase()) {
    return "Host [hidden]";
  }
  return host.name;
}

export function hostCardSubtitle(host: PrivacyHostRef, privacy: boolean): string {
  if (!privacy) return `${host.username}@${host.host}:${host.port}`;
  return `${host.username} · [address hidden]`;
}

export function formatSessionTabLabel(
  host: PrivacyHostRef | undefined,
  fallbackFullLabel: string,
  privacy: boolean
): string {
  if (!privacy) {
    return host ? `${host.name} (${host.username}@${host.host})` : fallbackFullLabel;
  }
  if (!host) return "Session [hidden]";
  const title = hostCardTitle(host, true);
  return `${title} (${host.username} @ [hidden])`;
}

export function formatSftpBannerLabel(host: PrivacyHostRef | undefined, fallbackFullLabel: string, privacy: boolean): string {
  return formatSessionTabLabel(host, fallbackFullLabel, privacy);
}
