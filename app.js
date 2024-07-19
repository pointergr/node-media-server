import NodeMediaServer from "node-media-server";
import { loadConfig } from "./config.js";

const config = await loadConfig();

var nms = new NodeMediaServer(config);
nms.run();