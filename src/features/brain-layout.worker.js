import { layoutNotes } from "./brain-layout.js";

self.onmessage = ({ data }) => {
  self.postMessage(layoutNotes(data.graph, data.forces));
};
