import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [ip, bits] of [
  ["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],
  ["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],
  ["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",3],
]) blocked.addSubnet(ip, bits, "ipv4");
blocked.addSubnet("2001:db8::", 32, "ipv6");
const global = new BlockList();
global.addSubnet("2000::", 3, "ipv6");

export function webUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.port || url.hash || !url.hostname.includes(".") || isIP(url.hostname) ||
      /\.(?:localhost|local|internal|lan|home|test|invalid)\.?$/i.test(url.hostname)) {
    throw new Error("Expected a public HTTP(S) hostname and URL without credentials");
  }
  return url;
}

export async function publicUrl(value) {
  const url = webUrl(value);
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address, family }) =>
    family === 4 ? blocked.check(address, "ipv4") :
      !global.check(address, "ipv6") || blocked.check(address, "ipv6"))) {
    throw new Error("Destination resolved to a restricted network");
  }
  return url;
}
