/**
 * Network auto-detection utilities
 * Detects local subnet for automatic IP whitelisting
 */

import { $ } from 'bun';

/**
 * Get local IP address of the server
 */
export async function getLocalIP(): Promise<string | null> {
  try {
    // Try to get primary network interface IP
    const result = await $`ip route get 1.1.1.1`.quiet();
    const match = result.stdout.toString().match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
    if (match) {
      return match[1];
    }

    // Fallback: try hostname -I (Linux/macOS)
    const hostnameResult = await $`hostname -I`.quiet();
    const ips = hostnameResult.stdout.toString().trim().split(/\s+/);
    if (ips.length > 0 && ips[0]) {
      return ips[0];
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Convert IP to /24 CIDR network
 * Example: 192.168.1.50 → 192.168.1.0/24
 */
export function ipToSubnet24(ip: string): string {
  const parts = ip.split('.');
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

/**
 * Auto-detect local network (/24 CIDR)
 */
export async function detectLocalNetwork(): Promise<string | null> {
  const ip = await getLocalIP();
  if (!ip) return null;

  return ipToSubnet24(ip);
}

/**
 * Common Docker networks
 */
export const DOCKER_NETWORKS = {
  bridge: '172.17.0.0/16',
  customBridge: ['172.18.0.0/16', '172.19.0.0/16'],
  compose: '172.20.0.0/16',
  kubernetes: {
    flannel: '10.244.0.0/16',
    calico: '10.32.0.0/12',
  },
};
