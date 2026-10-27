import { SocketService } from "./socket-service.mjs";

export class RitualService {
  // Keep UI callers unaware of local-vs-remote execution. Even the GM uses the
  // same queue, revision checks and permission checks as a player request.
  static async execute(actor, name, payload = {}) {
    return SocketService.request(actor, name, payload);
  }
}
