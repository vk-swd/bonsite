export function cacheBuster() {
  const arr = new Uint32Array(2);
  crypto.getRandomValues(arr);
  return ((arr[0] * 4294967296 + arr[1]) % 1e13)
    .toString()
    .padStart(13, "0");
}