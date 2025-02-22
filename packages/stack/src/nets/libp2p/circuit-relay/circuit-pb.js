const protobuf = require("protons");

module.exports = protobuf(`message CircuitRelay {
  enum Status {
    SUCCESS                    = 100;
    HOP_SRC_ADDR_TOO_LONG      = 220;
    HOP_DST_ADDR_TOO_LONG      = 221;
    HOP_SRC_MULTIADDR_INVALID  = 250;
    HOP_DST_MULTIADDR_INVALID  = 251;
    HOP_NO_CONN_TO_DST         = 260;
    HOP_CANT_DIAL_DST          = 261;
    HOP_CANT_OPEN_DST_STREAM   = 262;
    HOP_CANT_SPEAK_RELAY       = 270;
    HOP_CANT_RELAY_TO_SELF     = 280;
    STOP_SRC_ADDR_TOO_LONG     = 320;
    STOP_DST_ADDR_TOO_LONG     = 321;
    STOP_SRC_MULTIADDR_INVALID = 350;
    STOP_DST_MULTIADDR_INVALID = 351;
    STOP_RELAY_REFUSED         = 390;
    MALFORMED_MESSAGE          = 400;
  }
  enum Type { // RPC identifier, either HOP, STOP or STATUS
    HOP = 1;
    STOP = 2;
    STATUS = 3;
    CAN_HOP = 4;
  }
  message Peer {
    required bytes id = 1;    // peer id
    repeated bytes addrs = 2; // peer's known addresses
  }
  optional Type type = 1;     // Type of the message
  optional Peer srcPeer = 2;  // srcPeer and dstPeer are used when Type is HOP or STATUS
  optional Peer dstPeer = 3;
  optional Status code = 4;   // Status code, used when Type is STATUS
}`).CircuitRelay;
