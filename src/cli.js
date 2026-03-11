/**
 * CLI Argument Parser for Lobster Backup
 * 
 * Parses command-line arguments and returns a structured object with
 * command, flags, and any unknown commands.
 */

/**
 * Parse command line arguments
 * @param {string[]} args - Array of command line arguments
 * @returns {object} Parsed result with command, flags, and unknownCommand
 */
export function parseArgs(args) {
  const validCommands = ['setup', 'scan', 'backup', 'restore'];
  
  if (!args || args.length === 0) {
    return { command: 'help', flags: {}, unknownCommand: undefined };
  }
  
  const command = args[0];
  const flags = {};
  let unknownCommand = undefined;
  
  // Check if command is valid
  if (!validCommands.includes(command)) {
    return {
      command: 'help',
      flags: {},
      unknownCommand: command
    };
  }
  
  // Parse flags starting from second argument
  let i = 1;
  while (i < args.length) {
    const arg = args[i];
    
    if (!arg.startsWith('--')) {
      i++;
      continue;
    }
    
    switch (arg) {
      case '--register':
        flags.register = true;
        i++;
        break;
        
      case '--paths':
        // Collect all arguments after --paths until next flag or end
        flags.paths = [];
        i++;
        while (i < args.length && !args[i].startsWith('--')) {
          flags.paths.push(args[i]);
          i++;
        }
        break;
        
      case '--now':
        flags.now = true;
        i++;
        break;
        
      case '--list':
        flags.list = true;
        i++;
        break;
        
      case '--from':
        // Next argument is the path
        i++;
        if (i < args.length) {
          flags.from = args[i];
          i++;
        }
        break;
        
      case '--dry-run':
        flags.dryRun = true;
        i++;
        break;
        
      case '--help':
        flags.help = true;
        i++;
        break;
        
      default:
        // Unknown flag, skip it
        i++;
        break;
    }
  }
  
  return {
    command,
    flags,
    unknownCommand
  };
}