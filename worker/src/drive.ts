const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

export interface Photo {
	id: string;
	name: string;
	createdTime: string;
	/** Cambia cuando la foto se edita; la web lo usa para no mostrar una version vieja en cache. */
	modifiedTime?: string;
	/** Tamano en bytes y huella MD5 del contenido; la web los usa para saber si una foto ya se descargo completa. */
	size?: number;
	md5?: string;
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
	/** Grupo de fotos al que pertenece; su nombre es el nombre del negativo. */
	group?: string;
}

const TAGS_PREFIX = "museo:";
const MAX_PEOPLE = 60;

/** Valida y limpia etiquetas recibidas (o leidas de Drive); devuelve null si no tienen forma valida. */
export function sanitizeTags(input: unknown): PhotoTags | null {
	if (typeof input !== "object" || input === null) return null;
	const raw = input as { place?: unknown; people?: unknown; group?: unknown };
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

	const place = typeof raw.place === "string" ? raw.place.trim().slice(0, 100) : "";
	const group = typeof raw.group === "string" ? raw.group.trim().slice(0, 80) : "";

	const tags: PhotoTags = { people };
	if (place) tags.place = place;
	if (group) tags.group = group;
	return tags;
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
	/** Id de la foto que sirve de portada: la elegida o, si no hay, la primera de la sala. */
	cover?: string;
}

interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	createdTime: string;
	modifiedTime?: string;
	/** Drive lo entrega como texto. */
	size?: string;
	md5Checksum?: string;
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
		size: f.size ? Number(f.size) : undefined,
		md5: f.md5Checksum,
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
			fields: "nextPageToken,files(id,name,appProperties)",
			orderBy: "name",
			pageSize: "100",
		});
		if (pageToken) params.set("pageToken", pageToken);
		const res = await driveFetch(env, `${DRIVE_API}/files?${params}`);
		if (!res.ok) throw new Error(`Drive list de cuartos fallo (${res.status})`);
		const data = (await res.json()) as {
			files: { id: string; name: string; appProperties?: { cover?: string } }[];
			nextPageToken?: string;
		};
		rooms.push(...data.files.map((f) => ({ id: f.id, name: f.name, cover: f.appProperties?.cover })));
		pageToken = data.nextPageToken;
	} while (pageToken);

	// Las salas sin portada elegida usan su primera foto.
	await Promise.all(
		rooms.filter((r) => !r.cover).map(async (room) => {
			room.cover = await firstPhotoId(env, room.id);
		}),
	);

	cachedRooms = { rooms, expiresAt: Date.now() + 60_000 };
	return rooms;
}

async function firstPhotoId(env: Env, roomId: string): Promise<string | undefined> {
	const params = new URLSearchParams({
		q: `'${roomId}' in parents and mimeType contains 'image/' and trashed = false`,
		fields: "files(id)",
		orderBy: "createdTime",
		pageSize: "1",
	});
	const res = await driveFetch(env, `${DRIVE_API}/files?${params}`);
	if (!res.ok) return undefined;
	return ((await res.json()) as { files: { id: string }[] }).files[0]?.id;
}

/** Elige la foto de portada de una sala (o la quita con null, volviendo a la primera foto). */
export async function setRoomCover(env: Env, roomId: string, photoId: string | null): Promise<Room | null> {
	const rooms = await listRooms(env);
	if (!rooms.some((r) => r.id === roomId)) return null;
	if (photoId) {
		const meta = await getPhotoMeta(env, photoId);
		if (!meta?.parents?.includes(roomId)) return null;
	}
	const res = await driveFetch(env, `${DRIVE_API}/files/${encodeURIComponent(roomId)}?fields=id`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ appProperties: { cover: photoId } }),
	});
	if (!res.ok) throw new Error(`Drive portada fallo (${res.status})`);
	cachedRooms = null;
	return (await listRooms(env)).find((r) => r.id === roomId) ?? null;
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
			fields: "nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,size,md5Checksum,description,imageMediaMetadata(width,height))",
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

const PHOTO_FIELDS = "id,name,mimeType,createdTime,modifiedTime,size,md5Checksum,description,imageMediaMetadata(width,height)";

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
	/** Nombres de grupo (de negativo) ya usados. */
	groups: string[];
}

/** Nombres, lugares y grupos ya guardados en todas las fotos, de mas a menos usados. */
export async function listTagSuggestions(env: Env): Promise<TagSuggestions> {
	if (cachedSuggestions && cachedSuggestions.expiresAt > Date.now()) return cachedSuggestions.value;
	const rooms = await listRooms(env);
	const people = new Map<string, number>();
	const places = new Map<string, number>();
	const groups = new Map<string, number>();

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
				if (tags.group) groups.set(tags.group, (groups.get(tags.group) ?? 0) + 1);
				for (const p of tags.people) people.set(p.name, (people.get(p.name) ?? 0) + 1);
			}
			pageToken = data.nextPageToken;
		} while (pageToken);
	}

	const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
	const value = { people: sorted(people), places: sorted(places), groups: sorted(groups) };
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

/** Pasa una foto de su sala a otra (cambia su carpeta de Drive; la imagen y sus etiquetas no se tocan). */
export async function movePhoto(env: Env, id: string, toRoomId: string): Promise<Photo | null> {
	const meta = await getPhotoMeta(env, id);
	if (!meta) return null;
	const rooms = await listRooms(env);
	if (!rooms.some((r) => r.id === toRoomId)) return null;
	const fromRoom = rooms.find((r) => meta.parents?.includes(r.id));
	if (!fromRoom) return null;
	if (fromRoom.id === toRoomId) return toPhoto(meta);

	const params = new URLSearchParams({
		addParents: toRoomId,
		removeParents: fromRoom.id,
		fields: PHOTO_FIELDS,
	});
	const res = await driveFetch(env, `${DRIVE_API}/files/${encodeURIComponent(id)}?${params}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: "{}",
	});
	if (!res.ok) throw new Error(`Drive mover fallo (${res.status})`);

	// Si era la portada de la sala de origen, esa sala vuelve a usar su primera foto.
	if (fromRoom.cover === id) await setRoomCover(env, fromRoom.id, null).catch(() => undefined);
	cachedRooms = null;
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
	if (res.ok) {
		// Si era la portada de su sala, se limpia para que la sala vuelva a usar su primera foto.
		const rooms = await listRooms(env);
		const room = rooms.find((r) => meta.parents?.includes(r.id));
		if (room?.cover === id) await setRoomCover(env, room.id, null).catch(() => undefined);
		cachedRooms = null;
	}
	return res.ok;
}
