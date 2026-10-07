const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

export interface Photo {
	id: string;
	name: string;
	createdTime: string;
	width?: number;
	height?: number;
}

export interface Room {
	id: string;
	name: string;
}

interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	createdTime: string;
	parents?: string[];
	thumbnailLink?: string;
	imageMediaMetadata?: { width?: number; height?: number };
}

// El token de acceso no depende de la peticion, por eso es seguro cachearlo a nivel de modulo.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(env: Env): Promise<string> {
	if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
		return cachedToken.value;
	}
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
			refresh_token: env.GOOGLE_REFRESH_TOKEN,
			grant_type: "refresh_token",
		}),
	});
	if (!res.ok) {
		throw new Error(`No se pudo renovar el token de Google (${res.status})`);
	}
	const data = (await res.json()) as { access_token: string; expires_in: number };
	cachedToken = {
		value: data.access_token,
		expiresAt: Date.now() + data.expires_in * 1000,
	};
	return data.access_token;
}

async function driveFetch(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
	const token = await getAccessToken(env);
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${token}`);
	return fetch(url, { ...init, headers });
}

function toPhoto(f: DriveFile): Photo {
	return {
		id: f.id,
		name: f.name,
		createdTime: f.createdTime,
		width: f.imageMediaMetadata?.width,
		height: f.imageMediaMetadata?.height,
	};
}

// Lista de cuartos (subcarpetas) cacheada un minuto; no depende de la peticion.
let cachedRooms: { rooms: Room[]; expiresAt: number } | null = null;

export async function listRooms(env: Env): Promise<Room[]> {
	if (cachedRooms && cachedRooms.expiresAt > Date.now()) return cachedRooms.rooms;
	const rooms: Room[] = [];
	let pageToken: string | undefined;
	do {
		const params = new URLSearchParams({
			q: `'${env.DRIVE_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
			fields: "nextPageToken,files(id,name)",
			orderBy: "name",
			pageSize: "100",
		});
		if (pageToken) params.set("pageToken", pageToken);
		const res = await driveFetch(env, `${DRIVE_API}/files?${params}`);
		if (!res.ok) throw new Error(`Drive list de cuartos fallo (${res.status})`);
		const data = (await res.json()) as { files: Room[]; nextPageToken?: string };
		rooms.push(...data.files.map((f) => ({ id: f.id, name: f.name })));
		pageToken = data.nextPageToken;
	} while (pageToken);
	cachedRooms = { rooms, expiresAt: Date.now() + 60_000 };
	return rooms;
}

export async function createRoom(env: Env, name: string): Promise<Room> {
	const res = await driveFetch(env, `${DRIVE_API}/files?fields=id,name`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			name,
			mimeType: "application/vnd.google-apps.folder",
			parents: [env.DRIVE_FOLDER_ID],
		}),
	});
	if (!res.ok) throw new Error(`Drive crear cuarto fallo (${res.status})`);
	cachedRooms = null;
	return (await res.json()) as Room;
}

export async function isRoom(env: Env, roomId: string): Promise<boolean> {
	return (await listRooms(env)).some((r) => r.id === roomId);
}

export async function listPhotos(env: Env, roomId: string): Promise<Photo[] | null> {
	if (!(await isRoom(env, roomId))) return null;
	const photos: Photo[] = [];
	let pageToken: string | undefined;
	do {
		const params = new URLSearchParams({
			q: `'${roomId}' in parents and mimeType contains 'image/' and trashed = false`,
			fields: "nextPageToken,files(id,name,mimeType,createdTime,imageMediaMetadata(width,height))",
			orderBy: "createdTime desc",
			pageSize: "1000",
		});
		if (pageToken) params.set("pageToken", pageToken);
		const res = await driveFetch(env, `${DRIVE_API}/files?${params}`);
		if (!res.ok) throw new Error(`Drive list fallo (${res.status})`);
		const data = (await res.json()) as { files: DriveFile[]; nextPageToken?: string };
		photos.push(...data.files.map(toPhoto));
		pageToken = data.nextPageToken;
	} while (pageToken);
	return photos;
}

/** Devuelve los metadatos solo si el archivo es una imagen dentro de uno de los cuartos. */
async function getPhotoMeta(env: Env, id: string): Promise<DriveFile | null> {
	const params = new URLSearchParams({
		fields: "id,name,mimeType,createdTime,parents,thumbnailLink,trashed",
	});
	const res = await driveFetch(env, `${DRIVE_API}/files/${encodeURIComponent(id)}?${params}`);
	if (!res.ok) return null;
	const file = (await res.json()) as DriveFile & { trashed?: boolean };
	if (file.trashed) return null;
	if (!file.mimeType.startsWith("image/")) return null;
	const rooms = await listRooms(env);
	if (!file.parents?.some((p) => rooms.some((r) => r.id === p))) return null;
	return file;
}

export async function getPhotoContent(env: Env, id: string): Promise<Response | null> {
	const meta = await getPhotoMeta(env, id);
	if (!meta) return null;
	const res = await driveFetch(env, `${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`);
	if (!res.ok) return null;
	return new Response(res.body, {
		headers: { "Content-Type": meta.mimeType },
	});
}

export async function getPhotoThumbnail(env: Env, id: string, width: number): Promise<Response | null> {
	const meta = await getPhotoMeta(env, id);
	if (!meta?.thumbnailLink) return null;
	// thumbnailLink termina en "=s220"; se cambia por el ancho pedido.
	const url = meta.thumbnailLink.replace(/=s\d+$/, `=w${width}`);
	const res = await fetch(url);
	if (!res.ok) return null;
	return new Response(res.body, {
		headers: { "Content-Type": res.headers.get("Content-Type") ?? "image/jpeg" },
	});
}

export async function uploadPhoto(env: Env, roomId: string, file: File): Promise<Photo | null> {
	if (!(await isRoom(env, roomId))) return null;
	const boundary = `museo-${crypto.randomUUID()}`;
	const metadata = JSON.stringify({ name: file.name, parents: [roomId] });
	const body = new Blob([
		`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
		`--${boundary}\r\nContent-Type: ${file.type}\r\n\r\n`,
		file,
		`\r\n--${boundary}--`,
	]);
	const params = new URLSearchParams({
		uploadType: "multipart",
		fields: "id,name,mimeType,createdTime,imageMediaMetadata(width,height)",
	});
	const res = await driveFetch(env, `${DRIVE_UPLOAD}?${params}`, {
		method: "POST",
		headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
		body,
	});
	if (!res.ok) throw new Error(`Drive upload fallo (${res.status})`);
	return toPhoto((await res.json()) as DriveFile);
}

/** Manda la foto a la papelera de Drive (se puede recuperar desde ahi). */
export async function trashPhoto(env: Env, id: string): Promise<boolean> {
	const meta = await getPhotoMeta(env, id);
	if (!meta) return false;
	const res = await driveFetch(env, `${DRIVE_API}/files/${encodeURIComponent(id)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ trashed: true }),
	});
	return res.ok;
}
