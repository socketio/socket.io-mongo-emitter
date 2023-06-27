import debugModule from "debug";
import type {
  DefaultEventsMap,
  EventNames,
  EventParams,
  EventsMap,
  TypedEventBroadcaster,
} from "./typed-events";

const debug = debugModule("socket.io-mongo-emitter");
const EMITTER_UID = "emitter";

/**
 * Event types, for messages between nodes
 */

enum EventType {
  INITIAL_HEARTBEAT = 1,
  HEARTBEAT,
  BROADCAST,
  SOCKETS_JOIN,
  SOCKETS_LEAVE,
  DISCONNECT_SOCKETS,
  FETCH_SOCKETS,
  FETCH_SOCKETS_RESPONSE,
  SERVER_SIDE_EMIT,
  SERVER_SIDE_EMIT_RESPONSE,
}

interface BroadcastFlags {
  volatile?: boolean;
  compress?: boolean;
}

export interface MongoEmitterOptions {
  /**
   * Add a createdAt field to each MongoDB document
   * @default false
   */
  addCreatedAtField?: boolean;
}

export class Emitter<
  EmitEvents extends EventsMap = DefaultEventsMap,
  ServerSideEvents extends EventsMap = DefaultEventsMap
> {
  private mongoCollection: any;
  private opts: Required<MongoEmitterOptions>;

  constructor(
    mongoCollection: any,
    readonly nsp: string = "/",
    opts: MongoEmitterOptions = {}
  ) {
    this.mongoCollection = mongoCollection;
    this.opts = Object.assign(
      {
        addCreatedAtField: false,
      },
      opts
    );
  }

  /**
   * Return a new emitter for the given namespace.
   *
   * @param nsp - namespace
   * @public
   */
  public of(nsp: string): Emitter {
    return new Emitter(
      this.mongoCollection,
      (nsp[0] !== "/" ? "/" : "") + nsp,
      this.opts
    );
  }

  /**
   * Emits to all clients.
   *
   * @return Always true
   * @public
   */
  public emit<Ev extends EventNames<EmitEvents>>(
    ev: Ev,
    ...args: EventParams<EmitEvents, Ev>
  ): true {
    return new BroadcastOperator<EmitEvents>(this).emit(ev, ...args);
  }

  /**
   * Targets a room when emitting.
   *
   * @param room
   * @return BroadcastOperator
   * @public
   */
  public to(room: string | string[]): BroadcastOperator<EmitEvents> {
    return new BroadcastOperator(this).to(room);
  }

  /**
   * Targets a room when emitting.
   *
   * @param room
   * @return BroadcastOperator
   * @public
   */
  public in(room: string | string[]): BroadcastOperator<EmitEvents> {
    return new BroadcastOperator(this).in(room);
  }

  /**
   * Excludes a room when emitting.
   *
   * @param room
   * @return BroadcastOperator
   * @public
   */
  public except(room: string | string[]): BroadcastOperator<EmitEvents> {
    return new BroadcastOperator(this).except(room);
  }

  /**
   * Sets a modifier for a subsequent event emission that the event data may be lost if the client is not ready to
   * receive messages (because of network slowness or other issues, or because they’re connected through long polling
   * and is in the middle of a request-response cycle).
   *
   * @return BroadcastOperator
   * @public
   */
  public get volatile(): BroadcastOperator<EmitEvents> {
    return new BroadcastOperator(this).volatile;
  }

  /**
   * Sets the compress flag.
   *
   * @param compress - if `true`, compresses the sending data
   * @return BroadcastOperator
   * @public
   */
  public compress(compress: boolean): BroadcastOperator<EmitEvents> {
    return new BroadcastOperator(this).compress(compress);
  }

  /**
   * Makes the matching socket instances join the specified rooms
   *
   * @param rooms
   * @public
   */
  public socketsJoin(rooms: string | string[]): void {
    return new BroadcastOperator(this).socketsJoin(rooms);
  }

  /**
   * Makes the matching socket instances leave the specified rooms
   *
   * @param rooms
   * @public
   */
  public socketsLeave(rooms: string | string[]): void {
    return new BroadcastOperator(this).socketsLeave(rooms);
  }

  /**
   * Makes the matching socket instances disconnect
   *
   * @param close - whether to close the underlying connection
   * @public
   */
  public disconnectSockets(close: boolean = false): void {
    return new BroadcastOperator(this).disconnectSockets(close);
  }

  /**
   * Send a packet to the Socket.IO servers in the cluster
   *
   * @param args - any number of serializable arguments
   */
  public serverSideEmit<Ev extends EventNames<ServerSideEvents>>(
    ev: Ev,
    ...args: EventParams<ServerSideEvents, Ev>
  ): void {
    const withAck = args.length && typeof args[args.length - 1] === "function";

    if (withAck) {
      throw new Error("Acknowledgements are not supported");
    }

    this._publish({
      type: EventType.SERVER_SIDE_EMIT,
      data: {
        packet: [ev, ...args],
      },
    });
  }

  _publish(document: any) {
    document.uid = EMITTER_UID;
    document.nsp = this.nsp;

    if (this.opts.addCreatedAtField) {
      document.createdAt = new Date();
    }

    debug("publishing %j", document);
    this.mongoCollection.insertOne(document);
  }
}

export const RESERVED_EVENTS: ReadonlySet<string | Symbol> = new Set(<const>[
  "connect",
  "connect_error",
  "disconnect",
  "disconnecting",
  "newListener",
  "removeListener",
]);

export class BroadcastOperator<EmitEvents extends EventsMap>
  implements TypedEventBroadcaster<EmitEvents> {
  constructor(
    private readonly emitter: Emitter,
    private readonly rooms: Set<string> = new Set<string>(),
    private readonly exceptRooms: Set<string> = new Set<string>(),
    private readonly flags: BroadcastFlags = {}
  ) {}

  /**
   * Targets a room when emitting.
   *
   * @param room
   * @return a new BroadcastOperator instance
   * @public
   */
  public to(room: string | string[]): BroadcastOperator<EmitEvents> {
    const rooms = new Set(this.rooms);
    if (Array.isArray(room)) {
      room.forEach((r) => rooms.add(r));
    } else {
      rooms.add(room);
    }
    return new BroadcastOperator(
      this.emitter,
      rooms,
      this.exceptRooms,
      this.flags
    );
  }

  /**
   * Targets a room when emitting.
   *
   * @param room
   * @return a new BroadcastOperator instance
   * @public
   */
  public in(room: string | string[]): BroadcastOperator<EmitEvents> {
    return this.to(room);
  }

  /**
   * Excludes a room when emitting.
   *
   * @param room
   * @return a new BroadcastOperator instance
   * @public
   */
  public except(room: string | string[]): BroadcastOperator<EmitEvents> {
    const exceptRooms = new Set(this.exceptRooms);
    if (Array.isArray(room)) {
      room.forEach((r) => exceptRooms.add(r));
    } else {
      exceptRooms.add(room);
    }
    return new BroadcastOperator(
      this.emitter,
      this.rooms,
      exceptRooms,
      this.flags
    );
  }

  /**
   * Sets the compress flag.
   *
   * @param compress - if `true`, compresses the sending data
   * @return a new BroadcastOperator instance
   * @public
   */
  public compress(compress: boolean): BroadcastOperator<EmitEvents> {
    const flags = Object.assign({}, this.flags, { compress });
    return new BroadcastOperator(
      this.emitter,
      this.rooms,
      this.exceptRooms,
      flags
    );
  }

  /**
   * Sets a modifier for a subsequent event emission that the event data may be lost if the client is not ready to
   * receive messages (because of network slowness or other issues, or because they’re connected through long polling
   * and is in the middle of a request-response cycle).
   *
   * @return a new BroadcastOperator instance
   * @public
   */
  public get volatile(): BroadcastOperator<EmitEvents> {
    const flags = Object.assign({}, this.flags, { volatile: true });
    return new BroadcastOperator(
      this.emitter,
      this.rooms,
      this.exceptRooms,
      flags
    );
  }

  /**
   * Emits to all clients.
   *
   * @return Always true
   * @public
   */
  public emit<Ev extends EventNames<EmitEvents>>(
    ev: Ev,
    ...args: EventParams<EmitEvents, Ev>
  ): true {
    if (RESERVED_EVENTS.has(ev)) {
      throw new Error(`"${ev}" is a reserved event name`);
    }

    // set up packet object
    const data = [ev, ...args];
    const packet = {
      type: 2, // EVENT
      data: data,
      nsp: this.emitter.nsp,
    };

    const opts = {
      rooms: [...this.rooms],
      flags: this.flags,
      except: [...this.exceptRooms],
    };

    this.emitter._publish({
      type: EventType.BROADCAST,
      data: {
        packet,
        opts,
      },
    });

    return true;
  }

  /**
   * Makes the matching socket instances join the specified rooms
   *
   * @param rooms
   * @public
   */
  public socketsJoin(rooms: string | string[]): void {
    this.emitter._publish({
      type: EventType.SOCKETS_JOIN,
      data: {
        opts: {
          rooms: [...this.rooms],
          except: [...this.exceptRooms],
        },
        rooms: Array.isArray(rooms) ? rooms : [rooms],
      },
    });
  }

  /**
   * Makes the matching socket instances leave the specified rooms
   *
   * @param rooms
   * @public
   */
  public socketsLeave(rooms: string | string[]): void {
    this.emitter._publish({
      type: EventType.SOCKETS_LEAVE,
      data: {
        opts: {
          rooms: [...this.rooms],
          except: [...this.exceptRooms],
        },
        rooms: Array.isArray(rooms) ? rooms : [rooms],
      },
    });
  }

  /**
   * Makes the matching socket instances disconnect
   *
   * @param close - whether to close the underlying connection
   * @public
   */
  public disconnectSockets(close: boolean = false): void {
    this.emitter._publish({
      type: EventType.DISCONNECT_SOCKETS,
      data: {
        opts: {
          rooms: [...this.rooms],
          except: [...this.exceptRooms],
        },
        close,
      },
    });
  }
}
