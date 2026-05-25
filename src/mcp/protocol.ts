export {
  COMMANDS,
  DAEMON_CAPABILITIES,
  PROTOCOL_VERSION,
  RUNTIME_SCHEMA_VERSION
} from '../protocol.js';

export type { CommandSpec, ProtocolModule } from '../protocol.js';
export type CommandName = keyof typeof import('../protocol.js').COMMANDS & string;
