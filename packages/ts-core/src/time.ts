/**
 * Time utilities
 */

export class TimeUtils {
  /**
   * Get current UTC timestamp in ISO format
   */
  static now(): string {
    return new Date().toISOString();
  }

  /**
   * Parse ISO timestamp to Date
   */
  static parse(timestamp: string): Date {
    return new Date(timestamp);
  }

  /**
   * Check if timestamp is expired
   */
  static isExpired(timestamp: string, maxAgeSeconds: number): boolean {
    const date = new Date(timestamp);
    const ageMs = Date.now() - date.getTime();
    return ageMs > maxAgeSeconds * 1000;
  }

  /**
   * Get seconds elapsed since timestamp
   */
  static secondsSince(timestamp: string): number {
    const date = new Date(timestamp);
    return Math.floor((Date.now() - date.getTime()) / 1000);
  }

  /**
   * Add seconds to timestamp
   */
  static addSeconds(timestamp: string, seconds: number): string {
    const date = new Date(timestamp);
    date.setSeconds(date.getSeconds() + seconds);
    return date.toISOString();
  }

  /**
   * Format duration in human-readable format
   */
  static formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }
}
