/// <reference types="node" />
import { Server as HttpServer } from "http";
import { Server } from "socket.io";

interface Options {
    loadBalancingMethod?: "random" | "round-robin" | "least-connection";
}

export declare function setupMaster(httpServer: HttpServer, opts?: Options): void;
export declare function setupWorker(io: Server): void;
