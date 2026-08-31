import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File } from 'expo-file-system';
import { Image } from 'react-native';

/**
 * Long-edge cap and JPEG quality for anything we store or send. The relay
 * never sees plaintext, so this is the only place compression can ever
 * happen — there's no server-side resize step to fall back on. Resolution
 * matters far more than quality percentage for file size, since nobody
 * views a photo at full camera resolution on a phone screen anyway.
 */
const MAX_DIMENSION = 1440;
const JPEG_QUALITY = 0.8;

/** Opens the system image picker. Returns the picked file's local URI, or null if cancelled. */
export async function pickImage(): Promise<string | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    return null;
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 1,
  });

  return result.canceled ? null : result.assets[0].uri;
}

function getImageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
  });
}

export type CompressedImage = {
  /** Local file URI of the compressed copy — cheap to hand straight to <Image>, already resized. */
  uri: string;
  /** Same file's bytes — what actually gets stored/encrypted. */
  bytes: Uint8Array;
};

/**
 * Resizes `uri` so its longer edge is at most `MAX_DIMENSION`, re-encodes it
 * as JPEG at `JPEG_QUALITY`, and returns both the resulting file's URI and
 * its bytes. Caps whichever dimension is larger so a portrait photo doesn't
 * get capped on the wrong axis. Returning the URI too avoids callers that
 * just want to *display* the picture having to round-trip the bytes back
 * through a base64 data-URI when the resized file is already sitting on disk.
 */
export async function compressImage(uri: string): Promise<CompressedImage> {
  const { width, height } = await getImageSize(uri);
  const resize = width >= height ? { width: Math.min(width, MAX_DIMENSION) } : { height: Math.min(height, MAX_DIMENSION) };

  const rendered = await ImageManipulator.manipulate(uri).resize(resize).renderAsync();
  const saved = await rendered.saveAsync({ compress: JPEG_QUALITY, format: SaveFormat.JPEG });

  const bytes = await new File(saved.uri).arrayBuffer();
  return { uri: saved.uri, bytes: new Uint8Array(bytes) };
}

/** Picks an image and returns it already resized/compressed, or null if cancelled. */
export async function pickAndCompressImage(): Promise<CompressedImage | null> {
  const uri = await pickImage();
  return uri ? compressImage(uri) : null;
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i];
    const b2 = bytes[i + 1];
    const b3 = bytes[i + 2];
    result += BASE64_CHARS[b1 >> 2];
    result += BASE64_CHARS[((b1 & 0x03) << 4) | (b2 === undefined ? 0 : b2 >> 4)];
    result += b2 === undefined ? '=' : BASE64_CHARS[((b2 & 0x0f) << 2) | (b3 === undefined ? 0 : b3 >> 6)];
    result += b3 === undefined ? '=' : BASE64_CHARS[b3 & 0x3f];
  }
  return result;
}

/**
 * Turns stored picture bytes (e.g. `device_profile.picture`) into a URI
 * `<Image>` can render directly. Only worth it for one-off renders like a
 * single avatar — for a scrolling list of many photos, decode-per-render
 * is real overhead a stored file URI avoids (see `CompressedImage.uri`).
 */
export function bytesToDataUri(bytes: Uint8Array, mimeType = 'image/jpeg'): string {
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}
