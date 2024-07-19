import NodeMediaServer from "node-media-server";
import fs from "fs";

fs.readFile("./config.json", "utf8", (err, data) => {
  if (err) {
    console.error("Error reading config.json file:", err);
    return;
  }

  try {
    // Μετατρέπει το περιεχόμενο του αρχείου σε αντικείμενο
    return JSON.parse(data);
  } catch (parseErr) {
    console.error("Error parsing JSON string:", parseErr);
  }
});


var nms = new NodeMediaServer(config);
nms.run();