export function calcPaperStage(input: {
  viewerWidth: number;
  viewerHeight: number;
  margin: number;
  edgeRatio: number;
}): {
  paperWidth: number;
  paperHeight: number;
  leftEdgeWidth: number;
  rightEdgeWidth: number;
} {
  const margin = Math.max(0, input.margin);
  const paperWidth = Math.max(0, Math.floor(input.viewerWidth - margin * 2));
  const paperHeight = Math.max(0, Math.floor(input.viewerHeight - margin * 2));
  const ratio = Math.min(0.45, Math.max(0, input.edgeRatio));
  const edge = Math.min(220, Math.max(120, Math.round(paperWidth * ratio)));
  return { paperWidth, paperHeight, leftEdgeWidth: edge, rightEdgeWidth: edge };
}
