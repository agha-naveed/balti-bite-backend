// roadnet.js
// A road network built from the roads an admin drew by hand.
//
// WHY: the map is missing roads in Skardu, and when it cannot find one it falls
// back to a straight line - which says "0.5 km" when the real road is 2 km
// around a hill or a river. An admin draws the real road once; from then on any
// two points near the drawn roads get the distance ALONG them.
//
// HOW:
//   - Every point on a drawn road becomes a node; neighbouring points are joined
//     by an edge as long as the piece of road between them.
//   - Two roads that cross or touch (their points come within JUNCTION_M of each
//     other) are joined, so a route can turn from one onto the other.
//   - A start or end point is "snapped" to the closest spot on a drawn road, if
//     one is within SNAP_M. Both ends must snap, or this network is not used and
//     the normal road map decides instead.
//   - Dijkstra then finds the shortest way along the roads.

const JUNCTION_M = Number(process.env.ROAD_JUNCTION_METERS || 50);
const SNAP_M = Number(process.env.ROAD_SNAP_METERS || 300);

const toRad = (d) => (d * Math.PI) / 180;
function meters(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ----------------------------------------------------------- tiny heap */
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        let l = 2 * i + 1, r = l + 1, m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/* ---------------------------------------------------------- the graph */
// roads: [{ _id, name, path: [{lat,lng}], twoWay }]
function build(roads) {
  const nodes = []; // { lat, lng }
  const adj = []; // adj[i] = [{ to, w, oneWayFrom? }]
  const segments = []; // { a, b, road } node indexes, for snapping

  const addEdge = (a, b, w, twoWay) => {
    adj[a].push({ to: b, w });
    if (twoWay) adj[b].push({ to: a, w });
  };

  for (const road of roads) {
    const pts = (road.path || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (pts.length < 2) continue;
    let prev = -1;
    for (const p of pts) {
      const id = nodes.length;
      nodes.push({ lat: p.lat, lng: p.lng, road: String(road._id) });
      adj.push([]);
      if (prev >= 0) {
        addEdge(prev, id, meters(nodes[prev], nodes[id]), road.twoWay !== false);
        segments.push({ a: prev, b: id, road: road });
      }
      prev = id;
    }
  }

  // Join roads that meet. Bucket the nodes into a grid so this does not compare
  // every node with every other node.
  const CELL = 0.0006; // about 65 m
  const grid = new Map();
  const key = (lat, lng) => `${Math.floor(lat / CELL)},${Math.floor(lng / CELL)}`;
  nodes.forEach((n, i) => {
    const k = key(n.lat, n.lng);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  nodes.forEach((n, i) => {
    const cy = Math.floor(n.lat / CELL), cx = Math.floor(n.lng / CELL);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (const j of grid.get(`${cy + dy},${cx + dx}`) || []) {
          if (j <= i || nodes[j].road === n.road) continue; // other roads only
          const d = meters(n, nodes[j]);
          if (d <= JUNCTION_M) addEdge(i, j, d, true);
        }
  });

  return { nodes, adj, segments };
}

// Closest spot on any drawn road: { segment, t (0..1 along it), point, distM }
function snap(net, p) {
  let best = null;
  const cosLat = Math.cos(toRad(p.lat));
  for (const s of net.segments) {
    const A = net.nodes[s.a], B = net.nodes[s.b];
    // Flat-earth maths is fine over a few hundred metres.
    const ax = (A.lng - p.lng) * cosLat, ay = A.lat - p.lat;
    const bx = (B.lng - p.lng) * cosLat, by = B.lat - p.lat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const point = { lat: A.lat + (B.lat - A.lat) * t, lng: A.lng + (B.lng - A.lng) * t };
    const distM = meters(p, point);
    if (!best || distM < best.distM) best = { segment: s, t, point, distM };
  }
  return best && best.distM <= SNAP_M ? best : null;
}

// Shortest way along the drawn roads between two points, or null if either is
// too far from a road, or the roads do not connect them.
function route(net, from, to) {
  if (!net.segments.length) return null;
  const a = snap(net, from);
  const b = snap(net, to);
  if (!a || !b) return null;

  const N = net.nodes.length;
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const heap = new MinHeap();

  // The start sits somewhere in the middle of a segment, so it can leave toward
  // either end of it (respecting one-way roads).
  const sa = a.segment, sb = b.segment;
  const lenA = meters(net.nodes[sa.a], net.nodes[sa.b]);
  const seed = (n, d) => {
    if (d < dist[n]) {
      dist[n] = d;
      heap.push([d, n]);
    }
  };
  if (hasEdge(net, sa.a, sa.b)) seed(sa.b, lenA * (1 - a.t));
  if (hasEdge(net, sa.b, sa.a)) seed(sa.a, lenA * a.t);

  while (heap.size) {
    const [d, u] = heap.pop();
    if (d > dist[u]) continue;
    for (const e of net.adj[u]) {
      const nd = d + e.w;
      if (nd < dist[e.to]) {
        dist[e.to] = nd;
        prev[e.to] = u;
        heap.push([nd, e.to]);
      }
    }
  }

  // Arrive at the end by either end of its segment.
  const lenB = meters(net.nodes[sb.a], net.nodes[sb.b]);
  const options = [];
  if (hasEdge(net, sb.a, sb.b) && dist[sb.a] < Infinity)
    options.push({ node: sb.a, total: dist[sb.a] + lenB * b.t });
  if (hasEdge(net, sb.b, sb.a) && dist[sb.b] < Infinity)
    options.push({ node: sb.b, total: dist[sb.b] + lenB * (1 - b.t) });

  // Both on the same stretch of road: just walk along it.
  let sameSegment = null;
  if (sa === sb) {
    const forward = b.t >= a.t;
    if (hasEdge(net, forward ? sa.a : sa.b, forward ? sa.b : sa.a))
      sameSegment = Math.abs(b.t - a.t) * lenA;
  }

  if (!options.length && sameSegment === null) return null;
  options.sort((x, y) => x.total - y.total);
  const viaGraph = options[0];

  let along, line;
  if (sameSegment !== null && (!viaGraph || sameSegment <= viaGraph.total)) {
    along = sameSegment;
    line = [a.point, b.point];
  } else {
    along = viaGraph.total;
    const chain = [];
    for (let n = viaGraph.node; n !== -1; n = prev[n]) chain.push(net.nodes[n]);
    chain.reverse();
    line = [a.point, ...chain, b.point];
  }

  // The short walk from the real start/end to the road counts too.
  const totalM = along + a.distM + b.distM;
  return {
    distanceKm: Math.round((totalM / 1000) * 100) / 100,
    path: [[from.lat, from.lng], ...line.map((p) => [p.lat, p.lng]), [to.lat, to.lng]],
    roads: [...new Set([a.segment.road.name, b.segment.road.name])],
  };
}

function hasEdge(net, a, b) {
  return net.adj[a].some((e) => e.to === b);
}

module.exports = { build, route, snap, meters, SNAP_M, JUNCTION_M };
