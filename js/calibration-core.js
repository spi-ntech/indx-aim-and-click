export const IMAGE_WIDTH = 1280;
export const IMAGE_HEIGHT = 720;
export const MAX_MOVE_MM = 5;

export function createCalibrationMatrix(reference, xPoint, yPoint, xDistance = 1, yDistance = 1) {
  if (!(xDistance > 0) || !(yDistance > 0)) throw new Error('Axis calibration move distance must be greater than zero.');
  const matrix = {
    ax: { x: (xPoint.x - reference.x) / xDistance, y: (xPoint.y - reference.y) / xDistance },
    ay: { x: (yPoint.x - reference.x) / yDistance, y: (yPoint.y - reference.y) / yDistance }
  };
  assertUsableMatrix(matrix);
  return matrix;
}

export function matrixDeterminant(matrix) {
  return matrix.ax.x * matrix.ay.y - matrix.ay.x * matrix.ax.y;
}

export function assertUsableMatrix(matrix, minimumDeterminant = 100) {
  const determinant = matrixDeterminant(matrix);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < minimumDeterminant) {
    throw new Error('Image-axis calibration is too small. Check the clicked points.');
  }
  return determinant;
}

export function movementToReference(reference, point, matrix, maxMove = MAX_MOVE_MM) {
  const determinant = assertUsableMatrix(matrix);
  const pixelX = reference.x - point.x;
  const pixelY = reference.y - point.y;
  const x = (pixelX * matrix.ay.y - matrix.ay.x * pixelY) / determinant;
  const y = (matrix.ax.x * pixelY - pixelX * matrix.ax.y) / determinant;
  const distance = Math.hypot(x, y);
  if (distance > maxMove) {
    throw new Error(`Requested move ${distance.toFixed(2)} mm exceeds the ${maxMove} mm safety limit.`);
  }
  return { x, y, distance };
}

export function nudgePoint(point, pixelX, pixelY, width = IMAGE_WIDTH, height = IMAGE_HEIGHT) {
  return {
    ...point,
    x: Math.max(0, Math.min(width - 1, point.x + pixelX)),
    y: Math.max(0, Math.min(height - 1, point.y + pixelY))
  };
}

export function isPointInCentralRegion(point, width = IMAGE_WIDTH, height = IMAGE_HEIGHT, minimum = 0.3, maximum = 0.7) {
  return width > 0 && height > 0
    && point.x >= width * minimum && point.x <= width * maximum
    && point.y >= height * minimum && point.y <= height * maximum;
}

export function imagePointFromClient(clientX, clientY, imageRect, imageWidth = IMAGE_WIDTH, imageHeight = IMAGE_HEIGHT) {
  const scale = Math.min(imageRect.width / imageWidth, imageRect.height / imageHeight);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  const left = imageRect.left + (imageRect.width - drawWidth) / 2;
  const top = imageRect.top + (imageRect.height - drawHeight) / 2;
  return { x: (clientX - left) / scale, y: (clientY - top) / scale };
}

export function imagePointToClient(point, imageRect, imageWidth = IMAGE_WIDTH, imageHeight = IMAGE_HEIGHT) {
  const scale = Math.min(imageRect.width / imageWidth, imageRect.height / imageHeight);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  return {
    x: imageRect.left + (imageRect.width - drawWidth) / 2 + point.x * scale,
    y: imageRect.top + (imageRect.height - drawHeight) / 2 + point.y * scale
  };
}
