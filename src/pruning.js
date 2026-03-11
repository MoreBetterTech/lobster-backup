/**
 * pruning.js — Backup retention and pruning functionality
 * 
 * Implements tier-based pruning with hourly and daily retention policies.
 */

import fs from 'node:fs';

/**
 * Prune backups based on retention policies
 * @param {object[]} backups - Array of backup objects
 * @param {string} backups[].filename - Backup filename
 * @param {string} backups[].path - Full path to backup file
 * @param {Date} backups[].timestamp - Backup timestamp
 * @param {boolean} backups[].manual - Whether this is a manual backup
 * @param {number} backups[].size - Backup size in bytes
 * @param {object} options - Pruning options
 * @param {number} [options.maxHourly=24] - Maximum number of hourly backups to keep
 * @param {number} [options.maxDaily=7] - Maximum number of daily snapshots to keep
 * @returns {object} Result object with kept, pruned, and dailySnapshots arrays
 */
export function pruneBackups(backups, options = {}) {
  const { maxHourly = 24, maxDaily = 7 } = options;
  
  if (!Array.isArray(backups) || backups.length === 0) {
    return {
      kept: [],
      pruned: [],
      dailySnapshots: []
    };
  }
  
  // Separate manual backups (never pruned)
  const manualBackups = backups.filter(backup => backup.manual);
  const automaticBackups = backups.filter(backup => !backup.manual);
  
  // Sort automatic backups by timestamp (newest first)
  automaticBackups.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  
  const kept = [...manualBackups]; // Manual backups are always kept
  const pruned = [];
  const dailySnapshots = [];
  
  if (automaticBackups.length === 0) {
    return { kept, pruned, dailySnapshots };
  }
  
  // Always keep the most recent backup regardless of age
  const mostRecent = automaticBackups[0];
  kept.push(mostRecent);
  
  // Process hourly tier - keep the most recent maxHourly backups
  const hourlyKept = automaticBackups.slice(0, maxHourly);
  const olderBackups = automaticBackups.slice(maxHourly);
  
  // Add hourly backups to kept list (except most recent which is already added)
  for (let i = 1; i < hourlyKept.length; i++) {
    kept.push(hourlyKept[i]);
  }
  
  // Process daily snapshots from older backups
  if (olderBackups.length > 0) {
    // Group older backups by calendar day
    const dailyGroups = new Map();
    
    for (const backup of olderBackups) {
      const dateKey = backup.timestamp.toISOString().split('T')[0]; // YYYY-MM-DD
      
      if (!dailyGroups.has(dateKey)) {
        dailyGroups.set(dateKey, []);
      }
      dailyGroups.get(dateKey).push(backup);
    }
    
    // Sort days by date (newest first)
    const sortedDays = Array.from(dailyGroups.entries())
      .sort((a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime());
    
    // Keep one backup per day, up to maxDaily days
    let dailyCount = 0;
    for (const [dateKey, dayBackups] of sortedDays) {
      if (dailyCount >= maxDaily) {
        // Add remaining backups to pruned list
        pruned.push(...dayBackups);
      } else {
        // Sort backups within this day by timestamp (newest first)
        dayBackups.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        
        // Keep the most recent backup from this day as a daily snapshot
        const dailySnapshot = dayBackups[0];
        kept.push(dailySnapshot);
        dailySnapshots.push(dailySnapshot);
        
        // Prune the rest from this day
        if (dayBackups.length > 1) {
          pruned.push(...dayBackups.slice(1));
        }
        
        dailyCount++;
      }
    }
  }
  
  // Actually delete the pruned files
  for (const backup of pruned) {
    try {
      fs.unlinkSync(backup.path);
    } catch (error) {
      // Log error but continue with other deletions
      console.warn(`Failed to delete backup ${backup.path}: ${error.message}`);
    }
  }
  
  return {
    kept,
    pruned,
    dailySnapshots
  };
}