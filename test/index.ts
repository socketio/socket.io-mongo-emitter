import { createServer } from "http";
import { Server, Socket as ServerSocket } from "socket.io";
import { io as ioc, Socket as ClientSocket } from "socket.io-client";
import expect = require("expect.js");
import { createAdapter } from "@socket.io/mongo-adapter";
import type { AddressInfo } from "net";
import { MongoClient } from "mongodb";
import { times, sleep } from "./util";
import { Emitter } from "..";

const NODES_COUNT = 3;

describe("@socket.io/mongodb-adapter", () => {
  let servers: Server[],
    serverSockets: ServerSocket[],
    clientSockets: ClientSocket[],
    mongoClient: MongoClient,
    emitter: Emitter;

  beforeEach((done) => {
    servers = [];
    serverSockets = [];
    clientSockets = [];
    mongoClient = new MongoClient("mongodb://localhost:27017/?replicaSet=rs0", {
      useUnifiedTopology: true, // prevent warnings in the console
    });
    mongoClient.connect(() => {
      const collection = mongoClient.db("test").collection("events");
      emitter = new Emitter(collection);

      for (let i = 1; i <= NODES_COUNT; i++) {
        const httpServer = createServer();
        const io = new Server(httpServer);
        // @ts-ignore
        io.adapter(createAdapter(collection));
        httpServer.listen(() => {
          const port = (httpServer.address() as AddressInfo).port;
          const clientSocket = ioc(`http://localhost:${port}`);

          io.on("connection", async (socket) => {
            clientSockets.push(clientSocket);
            serverSockets.push(socket);
            servers.push(io);
            if (servers.length === NODES_COUNT) {
              // ensure all nodes know each other
              servers[0].emit("ping");
              servers[1].emit("ping");
              servers[2].emit("ping");

              await sleep(200);

              done();
            }
          });
        });
      }
    });
  });

  afterEach((done) => {
    servers.forEach((server) => {
      // @ts-ignore
      server.httpServer.close();
      server.of("/").adapter.close();
    });
    clientSockets.forEach((socket) => {
      socket.disconnect();
    });
    mongoClient.close(done);
  });

  describe("broadcast", function () {
    it("broadcasts to all clients", (done) => {
      const partialDone = times(3, done);

      clientSockets.forEach((clientSocket) => {
        clientSocket.on("test", (arg1, arg2, arg3) => {
          expect(arg1).to.eql(1);
          expect(arg2).to.eql("2");
          expect(Buffer.isBuffer(arg3)).to.be(true);
          partialDone();
        });
      });

      emitter.emit("test", 1, "2", Buffer.from([3, 4]));
    });

    it("broadcasts to all clients in a namespace", (done) => {
      const partialDone = times(3, () => {
        servers.forEach((server) => server.of("/custom").adapter.close());
        done();
      });

      servers.forEach((server) => server.of("/custom"));

      const onConnect = times(3, () => {
        emitter.of("/custom").emit("test");
      });

      clientSockets.forEach((clientSocket) => {
        const socket = clientSocket.io.socket("/custom");
        socket.on("connect", onConnect);
        socket.on("test", () => {
          socket.disconnect();
          partialDone();
        });
      });
    });

    it("broadcasts to all clients in a room", (done) => {
      serverSockets[1].join("room1");

      clientSockets[0].on("test", () => {
        done(new Error("should not happen"));
      });

      clientSockets[1].on("test", () => {
        done();
      });

      clientSockets[2].on("test", () => {
        done(new Error("should not happen"));
      });

      emitter.to("room1").emit("test");
    });

    it("broadcasts to all clients except in room", (done) => {
      const partialDone = times(2, done);
      serverSockets[1].join("room1");

      clientSockets[0].on("test", () => {
        partialDone();
      });

      clientSockets[1].on("test", () => {
        done(new Error("should not happen"));
      });

      clientSockets[2].on("test", () => {
        partialDone();
      });

      emitter.of("/").except("room1").emit("test");
    });
  });

  describe("socketsJoin", () => {
    it("makes all socket instances join the specified room", async () => {
      emitter.socketsJoin("room1");

      await sleep(200);

      expect(serverSockets[0].rooms.has("room1")).to.be(true);
      expect(serverSockets[1].rooms.has("room1")).to.be(true);
      expect(serverSockets[2].rooms.has("room1")).to.be(true);
    });

    it("makes the matching socket instances join the specified room", async () => {
      serverSockets[0].join("room1");
      serverSockets[2].join("room1");

      emitter.in("room1").socketsJoin("room2");

      await sleep(200);

      expect(serverSockets[0].rooms.has("room2")).to.be(true);
      expect(serverSockets[1].rooms.has("room2")).to.be(false);
      expect(serverSockets[2].rooms.has("room2")).to.be(true);
    });

    it("makes the given socket instance join the specified room", async () => {
      emitter.in(serverSockets[1].id).socketsJoin("room3");

      await sleep(200);

      expect(serverSockets[0].rooms.has("room3")).to.be(false);
      expect(serverSockets[1].rooms.has("room3")).to.be(true);
      expect(serverSockets[2].rooms.has("room3")).to.be(false);
    });
  });

  describe("socketsLeave", () => {
    it("makes all socket instances leave the specified room", async () => {
      serverSockets[0].join("room1");
      serverSockets[2].join("room1");

      emitter.socketsLeave("room1");

      await sleep(200);

      expect(serverSockets[0].rooms.has("room1")).to.be(false);
      expect(serverSockets[1].rooms.has("room1")).to.be(false);
      expect(serverSockets[2].rooms.has("room1")).to.be(false);
    });

    it("makes the matching socket instances leave the specified room", async () => {
      serverSockets[0].join(["room1", "room2"]);
      serverSockets[1].join(["room1", "room2"]);
      serverSockets[2].join(["room2"]);

      emitter.in("room1").socketsLeave("room2");

      await sleep(200);

      expect(serverSockets[0].rooms.has("room2")).to.be(false);
      expect(serverSockets[1].rooms.has("room2")).to.be(false);
      expect(serverSockets[2].rooms.has("room2")).to.be(true);
    });

    it("makes the given socket instance leave the specified room", async () => {
      serverSockets[0].join("room3");
      serverSockets[1].join("room3");
      serverSockets[2].join("room3");

      emitter.in(serverSockets[1].id).socketsLeave("room3");

      await sleep(200);

      expect(serverSockets[0].rooms.has("room3")).to.be(true);
      expect(serverSockets[1].rooms.has("room3")).to.be(false);
      expect(serverSockets[2].rooms.has("room3")).to.be(true);
    });
  });

  describe("disconnectSockets", () => {
    it("makes all socket instances disconnect", (done) => {
      const partialDone = times(3, done);

      clientSockets.forEach((clientSocket) => {
        clientSocket.on("disconnect", (reason) => {
          expect(reason).to.eql("io server disconnect");
          partialDone();
        });
      });

      emitter.disconnectSockets();
    });
  });

  describe("serverSideEmit", () => {
    it("sends an event to other server instances", (done) => {
      const partialDone = times(3, done);

      emitter.serverSideEmit("hello", "world", 1, "2");

      servers[0].on("hello", (arg1, arg2, arg3) => {
        expect(arg1).to.eql("world");
        expect(arg2).to.eql(1);
        expect(arg3).to.eql("2");
        partialDone();
      });

      servers[1].on("hello", (arg1, arg2, arg3) => {
        partialDone();
      });

      servers[2].of("/").on("hello", () => {
        partialDone();
      });
    });
  });
});
