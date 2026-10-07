const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

export interface Photo {
	id: string;
	name: string;
	createdTime: string;
	/** Cambia cuando la foto se edita; la web lo usa para no mostrar una version vieja en cache. */
	modifiedTime?: string;
	width?: number;
	height?: number;
	/** Personas marcadas y lugar; se guardan en la descripcion del archivo de Drive. */
	tags?: PhotoTags;
}

export interface PersonTag {
	name: string;
	/** Posicion del punto sobre la foto, de 0 a 1. Sin punto, la persona va al final de la lista. */
	x?: number;
	y?: number;
}

export interface PhotoTags {
	place?: string;
	/** Siempre ordenadas de izquierda a derecha segun su punto. */
	people: PersonTag[];
	/** Nombres de los grupos aplicados a esta foto. */
	groups?: string[];
}

export interface Group {
	name: string;
	members: string[];
}

const TAGS_PREFIX = "museo:";
const MAX_PEOPLE = 60;

/** Valida y limpia etiquetas recibidas (o leidas de Drive); devuelve null si no tienen forma valida. */
export function sanitizeTags(input: unknown): PhotoTags | null {
	if (typeof input !== "object" || input === null) return null;
	const raw = input as { place?: unknown; people?: unknown; groups?: unknown };
	const people: PersonTag[] = [];
	if (Array.isArray(raw.people)) {
		for (const p of raw.people.slice(0, MAX_PEOPLE)) {
			const item = p as { name?: unknown; x?: unknown; y?: unknown };
			const name = typeof item?.name === "string" ? item.name.trim().slice(0, 60) : "";
			if (!name) continue;
			const x = item.x === undefined || item.x === null ? NaN : Number(item.x);
			const y = item.y === undefined || item.y === null ? NaN : Number(item.y);
			if (Number.isFinite(x) && Number.isFinite(y)) {
				people.push({ name, x: Math.min(Math.max(x, 0), 1), y: Math.min(Math.max(y, 0), 1) });
			} else {
				people.push({ name });
			}
		}
	}
	// Orden de izquierda a derecha; las personas sin punto quedan al final (el orden es estable).
	people.sort((a, b) => (a.x ?? Infinity) - (b.x ?? Infinity));

	const groups = Array.isArray(raw.groups)
		? [...new Set(raw.groups.filter((g): g is string => typeof g === "string").map((g) => g.trim().slice(0, 60)).filter(Boolean))].slice(0, 20)
		: [];
	const place = typeof raw.place === "string" ? raw.place.trim().slice(0, 100) : "";

	const tags: PhotoTags = { people };
	if (place) tags.place = place;
	if (groups.length > 0) tags.groups = groups;
	return tags;
}

/** Valida la lista de grupos recibida. */
export function sanitizeGroups(input: unknown): Group[] | null {
	if (!Array.isArray(input)) return null;
	const seen = new Set<string>();
	const groups: Group[] = [];
	for (const g of input.slice(0, 60)) {
		const item = g as { name?: unknown; members?: unknown };
		const name = typeof item?.name === "string" ? item.name.trim().slice(0, 60) : "";
		if (!name || seen.has(name.toLowerCase())) continue;
		seen.add(name.toLowerCase());
		const members = Array.isArray(item.members)
			? [...new Set(item.members.filter((m): m is string => typeof m === "string").map((m) => m.trim().slice(0, 60)).filter(Boolean))].slice(0, MAX_PEOPLE)
			: [];
		groups.push({ name, members });
	}
	return groups;
}

function parseTags(description?: string): PhotoTags | undefined {
	if (!description?.startsWith(TAGS_PREFIX)) return undefined;
	try {
		return sanitizeTags(JSON.parse(description.slice(TAGS_PREFIX.length))) ?? undefined;
	} catch {
		return undefined;
	}
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
	modifiedTime?: string;
	description?: string;
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
		modifiedTime: f.modifiedTime,
		width: f.imageMediaMetadata?.width,
		height: f.imageMediaMetadata?.height,
		tags: parseTags(f.description),
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
			fields: "nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,description,imageMediaMetadata(width,height))",
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

const PHOTO_FIELDS = "id,name,mimeType,createdTime,modifiedTime,description,imageMediaMetadata(width,height)";

/** Cuerpo multipart/related de Drive: metadatos JSON + contenido del archivo. */
function multipartBody(metadata: object, file: File) {
	const boundary = `museo-${crypto.randomUUID()}`;
	const body = new Blob([
		`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
		`--${boundary}\r\nContent-Type: ${file.type}\r\n\r\n`,
		file,
		`\r\n--${boundary}--`,
	]);
	return { body, contentType: `multipart/related; boundary=${boundary}` };
}

export async function uploadPhoto(env: Env, roomId: string, file: File): Promise<Photo | null> {
	if (!(await isRoom(env, roomId))) return null;
	const { body, contentType } = multipartBody({ name: file.name, parents: [roomId] }, file);
	const params = new URLSearchParams({ uploadType: "multipart", fields: PHOTO_FIELDS });
	const res = await driveFetch(env, `${DRIVE_UPLOAD}?${params}`, {
		method: "POST",
		headers: { "Content-Type": contentType },
		body,
	});
	if (!res.ok) throw new Error(`Drive upload fallo (${res.status})`);
	return toPhoto((await res.json()) as DriveFile);
}

/** Cambia el nombre y/o las etiquetas (personas y lugar) de una foto, sin tocar la imagen. */
export async function updatePhotoMeta(
	env: Env,
	id: string,
	changes: { name?: string; tags?: PhotoTags },
): Promise<Photo | null> {
	if (!(await getPhotoMeta(env, id))) return null;
	const body: { name?: string; description?: string } = {};
	if (changes.name) body.name = changes.name;
	if (changes.tags) body.description = `${TAGS_PREFIX}${JSON.stringify(changes.tags)}`;
	const params = new URLSearchParams({ fields: PHOTO_FIELDS });
	const res = await driveFetch(env, `${DRIVE_API}/files/${encodeURIComponent(id)}?${params}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Drive actualizar fallo (${res.status})`);
	cachedSuggestions = null;
	return toPhoto((await res.json()) as DriveFile);
}

// Sugerencias para el texto predictivo, cacheadas un minuto; no dependen de la peticion.
let cachedSuggestions: { value: TagSuggestions; expiresAt: number } | null = null;

export interface TagSuggestions {
	people: string[];
	places: string[];
}

/** Nombres y lugares ya guardados en todas las fotos, de mas a menos usados. */
export async function listTagSuggestions(env: Env): Promise<TagSuggestions> {
	if (cachedSuggestions && cachedSuggestions.expiresAt > Date.now()) return cachedSuggestions.value;
	const rooms = await listRooms(env);
	const people = new Map<string, number>();
	const places = new Map<string, number>();

	if (rooms.length > 0) {
		const parents = rooms.map((r) => `'${r.id}' in parents`).join(" or ");
		let pageToken: string | undefined;
		do {
			const params = new URLSearchParams({
				q: `(${parents}) and mimeType contains 'image/' and trashed = false`,
				fields: "nextPageToken,files(description)",
				pageSize: "1000",
			});
			if (pageToken) params.set("pageToken", pageToken);
			const res = await driveFetch(env, `${DRIVE_API}/files?${params}`);
			if (!res.ok) throw new Error(`Drive sugerencias fallo (${res.status})`);
			const data = (await res.json()) as { files: { description?: string }[]; nextPageToken?: string };
			for (const f of data.files) {
				const tags = parseTags(f.description);
				if (!tags) continue;
				if (tags.place) places.set(tags.place, (places.get(tags.place) ?? 0) + 1);
				for (const p of tags.people) people.set(p.name, (people.get(p.name) ?? 0) + 1);
			}
			pageToken = data.nextPageToken;
		} while (pageToken);
	}

	const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
	const value = { people: sorted(people), places: sorted(places) };
	cachedSuggestions = { value, expiresAt: Date.now() + 60_000 };
	return value;
}

/** Reemplaza la imagen de una foto existente (y opcionalmente su nombre). */
export async function replacePhoto(env: Env, id: string, file: File, name?: string): Promise<Photo | null> {
	if (!(await getPhotoMeta(env, id))) return null;
	const { body, contentType } = multipartBody(name ? { name } : {}, file);
	const params = new URLSearchParams({ uploadType: "multipart", fields: PHOTO_FIELDS });
	const res = await driveFetch(env, `${DRIVE_UPLOAD}/${encodeURIComponent(id)}?${params}`, {
		method: "PATCH",
		headers: { "Content-Type": contentType },
		body,
	});
	if (!res.ok) throw new Error(`Drive reemplazar fallo (${res.status})`);
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

// --- Grupos de personas: un archivo JSON en la carpeta principal del museo ---
const GROUPS_FILE = "museo-grupos.json";
let cachedGroups: { groups: Group[]; expiresAt: number } | null = null;

async function findGroupsFileId(env: Env): Promise<string | null> {
	const params = new URLSearchParams({
		q: `name = '${GROUPS_FILE}' and '${env.DRIVE_FOLDER_ID}' in parents and trashed = false`,
		fields: "files(id)",
		pageSize: "1",
	});
	const res = await driveFetch(env, `${DRIVE_API}/files?${params}`);
	if (!res.ok) throw new Error(`Drive buscar grupos fallo (${res.status})`);
	const data = (await res.json()) as { files: { id: string }[] };
	return data.files[0]?.id ?? null;
}

export async function getGroups(env: Env): Promise<Group[]> {
	if (cachedGroups && cachedGroups.expiresAt > Date.now()) return cachedGroups.groups;
	const id = await findGroupsFileId(env);
	let groups: Group[] = [];
	if (id) {
		const res = await driveFetch(env, `${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`);
		if (res.ok) groups = sanitizeGroups(await res.json().catch(() => [])) ?? [];
	}
	cachedGroups = { groups, expiresAt: Date.now() + 30_000 };
	return groups;
}

export async function saveGroups(env: Env, groups: Group[]): Promise<Group[]> {
	const file = new File([JSON.stringify(groups)], GROUPS_FILE, { type: "application/json" });
	const id = await findGroupsFileId(env);
	const params = new URLSearchParams({ uploadType: "multipart", fields: "id" });
	let res: Response;
	if (id) {
		const { body, contentType } = multipartBody({}, file);
		res = await driveFetch(env, `${DRIVE_UPLOAD}/${encodeURIComponent(id)}?${params}`, {
			method: "PATCH",
			headers: { "Content-Type": contentType },
			body,
		});
	} else {
		const { body, contentType } = multipartBody({ name: GROUPS_FILE, parents: [env.DRIVE_FOLDER_ID] }, file);
		res = await driveFetch(env, `${DRIVE_UPLOAD}?${params}`, {
			method: "POST",
			headers: { "Content-Type": contentType },
			body,
		});
	}
	if (!res.ok) throw new Error(`Drive guardar grupos fallo (${res.status})`);
	cachedGroups = { groups, expiresAt: Date.now() + 30_000 };
	return groups;
}
