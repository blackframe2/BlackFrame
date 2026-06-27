"use strict";

const STORAGE_KEY = "blackframe.supabase.v1.db";
const SESSION_KEY = "blackframe.supabase.v1.session";
const SUPABASE_URL = "https://TU_PROJECT_REF.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_wHNYpUt87Y5tYnzS2o50yA_Cf-xJm0Z";
const SUPABASE_STATE_ID = "blackframe-main";
const SUPABASE_MEDIA_BUCKET = "blackframe-media";
const CONTENT_TTL_DAYS = 62;

const navItems = [
  { id: "feed", label: "Inicio", icon: "⌂", kicker: "Inicio", title: "Feed" },
  { id: "reels", label: "Reels", icon: "▶", kicker: "Video", title: "Reels" },
  { id: "messages", label: "Mensajes", icon: "✉", kicker: "Chat", title: "Mensajes" },
  { id: "friends", label: "Amigos", icon: "◇", kicker: "Social", title: "Amigos" },
  { id: "search", label: "Buscar", icon: "⌕", kicker: "Explorar", title: "Buscador" },
  { id: "saved", label: "Guardados", icon: "▣", kicker: "Favoritos", title: "Guardados" },
  { id: "stats", label: "Estadísticas", icon: "▥", kicker: "Actividad", title: "Estadísticas" },
  { id: "settings", label: "Ajustes", icon: "⚙", kicker: "Cuenta", title: "Configuración" }
];

const state = {
  currentUserId: null,
  view: "feed",
  feedLimit: 8,
  activeTag: "",
  activeProfileId: null,
  profileTab: "posts",
  search: "",
  selectedConversationId: "",
  messageSearch: "",
  focusMode: false,
  typing: false,
  serverOnline: false,
  serverMessage: "Conectando Supabase",
  serverUrl: SUPABASE_URL
};

let db;
let reelObserver;
let serverSaveTimer;
let remoteVersion = 0;
let realtimeChannel;
const sb = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const uid = (prefix = "id") => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const now = () => new Date().toISOString();

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cleanUsername(value = "") {
  return String(value)
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._]/g, "")
    .slice(0, 24);
}

function formatDate(value) {
  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function initials(name = "BF") {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "BF";
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function detectMediaType(file) {
  if (!file) return "";
  if (file.type.startsWith("video/")) return "video";
  if (file.type === "image/gif") return "gif";
  if (file.type.startsWith("image/")) return "image";
  return "file";
}

function supabaseConfigured() {
  return Boolean(sb && SUPABASE_URL.startsWith("https://") && !SUPABASE_URL.includes("TU_PROJECT_REF"));
}

function emptyDatabase() {
  return {
    version: "supabase-1.0",
    createdAt: now(),
    updatedAt: now(),
    users: [],
    posts: [],
    reels: [],
    conversations: [],
    notifications: [],
    reports: []
  };
}

function hasMeaningfulData(snapshot) {
  if (!snapshot) return false;
  return Boolean(
    (snapshot.users?.length || 0) ||
    (snapshot.posts?.length || 0) ||
    (snapshot.reels?.length || 0) ||
    (snapshot.conversations?.length || 0)
  );
}

async function hashPassword(userId, password) {
  const input = `${userId}:${password}`;
  if (!window.crypto?.subtle) return `local:${btoa(unescape(encodeURIComponent(input)))}`;
  const bytes = new TextEncoder().encode(input);
  const digest = await window.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyPassword(user, password) {
  if (!user) return false;
  if (user.passwordHash) return user.passwordHash === await hashPassword(user.id, password);
  if (user.password && user.password === password) {
    user.passwordHash = await hashPassword(user.id, password);
    delete user.password;
    saveDatabase();
    return true;
  }
  return false;
}

function safeFilePart(value = "media") {
  return String(value)
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "media";
}

function mediaExtension(file, type) {
  const fromName = (file.name.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (type === "image") return "jpg";
  if (type === "gif") return "gif";
  if (type === "video") return fromName || (file.type.includes("webm") ? "webm" : "mp4");
  return fromName || "bin";
}

function compressImageFile(file) {
  if (!file?.type?.startsWith("image/") || file.type === "image/gif") return Promise.resolve(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const maxSide = 1440;
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#050505";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url);
        if (!blob) {
          resolve(file);
          return;
        }
        const compressed = new File([blob], `${safeFilePart(file.name)}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
        resolve(compressed.size < file.size ? compressed : file);
      }, "image/jpeg", 0.72);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("No se pudo procesar la imagen."));
    };
    img.src = url;
  });
}

async function uploadMediaFile(file, folder) {
  const type = detectMediaType(file);
  if (!file || !type) return null;
  if (type === "file") return { type, data: "", name: file.name, size: file.size, simulated: true };
  if (type === "gif" && file.size > 8 * 1024 * 1024) throw new Error("El GIF supera 8 MB. Usa uno mas liviano para cuidar Supabase.");
  if (type === "video" && file.size > 25 * 1024 * 1024) throw new Error("El video supera 25 MB. Comprímelo antes de subirlo.");
  const uploadFile = type === "image" ? await compressImageFile(file) : file;
  if (!supabaseConfigured()) {
    if (uploadFile.size > 1.5 * 1024 * 1024) throw new Error("Falta pegar SUPABASE_URL antes de subir archivos grandes.");
    return { type, data: await readFileAsDataUrl(uploadFile), name: file.name, size: uploadFile.size, local: true };
  }
  const path = `${folder}/${currentUser()?.id || "anon"}/${Date.now()}-${uid("media")}.${mediaExtension(uploadFile, type)}`;
  const { error } = await sb.storage.from(SUPABASE_MEDIA_BUCKET).upload(path, uploadFile, {
    cacheControl: "2592000",
    contentType: uploadFile.type || file.type || "application/octet-stream",
    upsert: false
  });
  if (error) throw error;
  const { data } = sb.storage.from(SUPABASE_MEDIA_BUCKET).getPublicUrl(path);
  return {
    type,
    data: data.publicUrl,
    name: file.name,
    size: uploadFile.size,
    storagePath: path,
    compressed: uploadFile.size < file.size
  };
}

async function uploadImageOnly(file, folder) {
  const media = await uploadMediaFile(file, folder);
  if (!media || !["image", "gif"].includes(media.type)) throw new Error("Sube una imagen valida.");
  return media.data;
}

async function deleteStorageMedia(media) {
  if (!media?.storagePath || !supabaseConfigured()) return;
  await sb.storage.from(SUPABASE_MEDIA_BUCKET).remove([media.storagePath]);
}

async function loadDatabase() {
  state.serverUrl = SUPABASE_URL;
  const raw = localStorage.getItem(STORAGE_KEY);
  const hasLocalDatabase = Boolean(raw);
  db = raw ? JSON.parse(raw) : seedDatabase();
  hydrateDatabase();
  pruneExpiredContent(false);
  if (hasLocalDatabase) saveDatabase({ sync: false });
  await pullDatabaseFromServer(false, { preferRemote: !hasLocalDatabase });
  subscribeRealtime();
}

function saveDatabase(options = {}) {
  if (options === false) options = { sync: false };
  db.updatedAt = now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  if (options.sync !== false) scheduleServerSave();
}

function scheduleServerSave() {
  if (!supabaseConfigured()) return;
  clearTimeout(serverSaveTimer);
  serverSaveTimer = setTimeout(() => pushDatabaseToServer(), 900);
}

async function pullDatabaseFromServer(showToast = false, options = {}) {
  if (!supabaseConfigured()) {
    state.serverOnline = false;
    state.serverMessage = "Falta pegar SUPABASE_URL";
    return false;
  }
  try {
    const { data: remote, error } = await sb
      .from("blackframe_state")
      .select("version,data,updated_at")
      .eq("id", SUPABASE_STATE_ID)
      .maybeSingle();
    if (error) throw error;
    state.serverOnline = true;
    state.serverMessage = "Supabase conectado";
    state.serverUrl = SUPABASE_URL;
    if (remote?.data) {
      const localTime = new Date(db.updatedAt || 0).getTime();
      const remoteTime = new Date(remote.data.updatedAt || remote.updated_at || 0).getTime();
      remoteVersion = Number(remote.version || 0);
      const remoteHasData = hasMeaningfulData(remote.data);
      const localHasData = hasMeaningfulData(db);
      if (options.preferRemote || remoteTime >= localTime || (!localHasData && remoteHasData)) {
        db = remote.data;
        hydrateDatabase();
        pruneExpiredContent(false);
        saveDatabase({ sync: false });
        if (showToast) toast("Sincronizado", "Se cargaron datos desde Supabase.");
      } else if (localTime > remoteTime && localHasData) {
        await pushDatabaseToServer(true);
      }
    } else {
      await pushDatabaseToServer(true);
    }
    return true;
  } catch (error) {
    state.serverOnline = false;
    state.serverMessage = "Supabase desconectado";
    if (showToast) toast("Supabase sin respuesta", "BlackFrame queda en caché local.");
    return false;
  }
}

async function pushDatabaseToServer(silent = false) {
  if (!supabaseConfigured() || !db) return false;
  try {
    pruneExpiredContent(false);
    if (!hasMeaningfulData(db)) {
      const { data: remote } = await sb
        .from("blackframe_state")
        .select("version,data,updated_at")
        .eq("id", SUPABASE_STATE_ID)
        .maybeSingle();
      if (hasMeaningfulData(remote?.data)) {
        db = remote.data;
        remoteVersion = Number(remote.version || 0);
        hydrateDatabase();
        saveDatabase({ sync: false });
        state.serverOnline = true;
        state.serverMessage = "Supabase protegido";
        if (!silent) renderServerStatusOnly();
        return false;
      }
    }
    db.updatedAt = now();
    const nextVersion = remoteVersion + 1;
    const { error } = await sb.from("blackframe_state").upsert({
      id: SUPABASE_STATE_ID,
      version: nextVersion,
      data: db,
      updated_at: new Date().toISOString()
    }, { onConflict: "id" });
    if (error) throw error;
    remoteVersion = nextVersion;
    state.serverOnline = true;
    state.serverMessage = `Guardado en Supabase · v${remoteVersion}`;
    if (!silent) renderServerStatusOnly();
    return true;
  } catch {
    state.serverOnline = false;
    state.serverMessage = "Supabase desconectado";
    if (!silent) renderServerStatusOnly();
    return false;
  }
}

function subscribeRealtime() {
  if (!supabaseConfigured()) return;
  if (realtimeChannel) sb.removeChannel(realtimeChannel);
  realtimeChannel = sb.channel("blackframe_state_live")
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "blackframe_state",
      filter: `id=eq.${SUPABASE_STATE_ID}`
    }, (payload) => {
      const incoming = payload.new;
      if (!incoming?.data) return;
      if (Number(incoming.version || 0) <= remoteVersion) return;
      if (!hasMeaningfulData(incoming.data) && hasMeaningfulData(db)) return;
      remoteVersion = Number(incoming.version || 0);
      db = incoming.data;
      hydrateDatabase();
      pruneExpiredContent(false);
      saveDatabase({ sync: false });
      render();
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        state.serverOnline = true;
        state.serverMessage = "Realtime activo";
        renderServerStatusOnly();
      }
    });
}

function renderServerStatusOnly() {
  const status = $("#serverStatus");
  if (!status) return;
  status.innerHTML = serverStatusInnerHtml();
}

function hydrateDatabase() {
  db.users ||= [];
  db.posts ||= [];
  db.reels ||= [];
  db.conversations ||= [];
  db.notifications ||= [];
  db.reports ||= [];
  db.users.forEach((user) => {
    user.followers ||= [];
    user.following ||= [];
    user.friends ||= [];
    user.requestsIn ||= [];
    user.requestsOut ||= [];
    user.savedPosts ||= [];
    user.savedReels ||= [];
    user.achievements ||= [];
    user.badges ||= [];
    user.settings ||= { language: "es", theme: "dark" };
    user.status ||= "Online";
    user.country ||= "Local";
    user.city ||= "";
    user.xp ||= 0;
    user.level ||= calculateLevel(user.xp);
    user.verified ||= "normal";
  });
  db.posts.forEach((post) => {
    post.likes ||= [];
    post.comments ||= [];
    post.shares ||= [];
    post.savedBy ||= [];
    post.views ||= [];
    post.tags ||= extractTags(post.text);
    post.mentions ||= extractMentions(post.text);
    post.comments.forEach((comment) => {
      comment.replies ||= [];
    });
  });
  db.reels.forEach((reel) => {
    reel.likes ||= [];
    reel.comments ||= [];
    reel.shares ||= [];
    reel.savedBy ||= [];
    reel.views ||= [];
  });
  syncAllUsers(false);
}

function pruneExpiredContent(shouldSave = true) {
  if (!db) return false;
  const cutoff = Date.now() - CONTENT_TTL_DAYS * 24 * 60 * 60 * 1000;
  const expiredPosts = new Set(db.posts.filter((post) => new Date(post.createdAt).getTime() < cutoff).map((post) => post.id));
  const expiredReels = new Set(db.reels.filter((reel) => new Date(reel.createdAt).getTime() < cutoff).map((reel) => reel.id));
  if (!expiredPosts.size && !expiredReels.size) return false;
  db.posts = db.posts.filter((post) => !expiredPosts.has(post.id));
  db.reels = db.reels.filter((reel) => !expiredReels.has(reel.id));
  db.users.forEach((user) => {
    user.savedPosts = (user.savedPosts || []).filter((id) => !expiredPosts.has(id));
    user.savedReels = (user.savedReels || []).filter((id) => !expiredReels.has(id));
  });
  db.notifications = db.notifications.filter((item) => !expiredPosts.has(item.entityId) && !expiredReels.has(item.entityId));
  if (shouldSave) saveDatabase();
  return true;
}

function demoSeedDatabaseUnused() {
  const createdAt = new Date(Date.now() - 1000 * 60 * 60 * 24 * 75).toISOString();
  const users = [
    {
      id: "u_demo",
      name: "Alex Frame",
      username: "demo",
      email: "demo@blackframe.local",
      password: "demo123",
      avatar: "",
      banner: "",
      bio: "Creador de clips, competitivo casual y fundador de BlackFrame local.",
      country: "Colombia",
      city: "Bogotá",
      createdAt,
      status: "Creando contenido",
      followers: ["u_nova", "u_byte", "u_aura"],
      following: ["u_nova", "u_aura"],
      friends: ["u_nova"],
      requestsIn: ["u_byte"],
      requestsOut: [],
      savedPosts: ["p_nova_1"],
      savedReels: ["r_aura_1"],
      xp: 1180,
      level: 5,
      verified: "blue",
      badges: ["⭐ Gamer", "🎮 Streamer", "💎 Premium", "👑 Fundador"],
      achievements: [],
      settings: { language: "es", theme: "dark" }
    },
    {
      id: "u_nova",
      name: "Nova Pixel",
      username: "novapixel",
      email: "nova@blackframe.local",
      password: "nova123",
      avatar: "",
      banner: "",
      bio: "Editora de highlights y reels verticales.",
      country: "México",
      city: "CDMX",
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 42).toISOString(),
      status: "Online",
      followers: ["u_demo", "u_aura"],
      following: ["u_demo"],
      friends: ["u_demo"],
      requestsIn: [],
      requestsOut: [],
      savedPosts: [],
      savedReels: [],
      xp: 760,
      level: 4,
      verified: "normal",
      badges: ["🎮 Streamer", "🏆 MVP"],
      achievements: [],
      settings: { language: "es", theme: "dark" }
    },
    {
      id: "u_byte",
      name: "Byte Rush",
      username: "byterush",
      email: "byte@blackframe.local",
      password: "byte123",
      avatar: "",
      banner: "",
      bio: "FPS, builds limpios y análisis de partidas.",
      country: "Chile",
      city: "Santiago",
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 28).toISOString(),
      status: "Buscando squad",
      followers: ["u_demo"],
      following: ["u_demo"],
      friends: [],
      requestsIn: [],
      requestsOut: ["u_demo"],
      savedPosts: [],
      savedReels: [],
      xp: 340,
      level: 3,
      verified: "normal",
      badges: ["⭐ Gamer"],
      achievements: [],
      settings: { language: "es", theme: "dark" }
    },
    {
      id: "u_aura",
      name: "Aura Live",
      username: "auralive",
      email: "aura@blackframe.local",
      password: "aura123",
      avatar: "",
      banner: "",
      bio: "Contenido cozy, directos largos y comunidad premium.",
      country: "Argentina",
      city: "Buenos Aires",
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 61).toISOString(),
      status: "En directo",
      followers: ["u_demo"],
      following: ["u_demo", "u_nova"],
      friends: [],
      requestsIn: [],
      requestsOut: [],
      savedPosts: [],
      savedReels: [],
      xp: 980,
      level: 4,
      verified: "normal",
      badges: ["🎮 Streamer", "💎 Premium"],
      achievements: [],
      settings: { language: "es", theme: "dark" }
    }
  ];

  const demoTexts = [
    "Probando el nuevo overlay de BlackFrame. Negro mate, silver shine y cero ruido visual. #blackframe #setup",
    "Hoy subí 3 clips y el algoritmo local ya se siente vivo. #reels #gamers",
    "Tip rápido: etiqueta tus jugadas con hashtags claros para que la galería tenga sentido. #tips #creadores",
    "Modo concentración activado para ver partidas sin paneles laterales. #focus",
    "Busco squad para ranked nocturno. @novapixel, ¿armamos algo? #ranked",
    "Mini encuesta: ¿qué prefieren para clips, cámara rápida o edición cinematográfica? #clips",
    "La sección de guardados ya es mi tablero de inspiración. #premium",
    "Primer stream editado directo desde el perfil. #streamer",
    "Me gusta que las insignias queden debajo del nombre. Se ve limpio. #perfil",
    "Casi listo el reto semanal de creadores. #community"
  ];

  const posts = demoTexts.map((text, index) => ({
    id: `p_demo_${index + 1}`,
    userId: "u_demo",
    text,
    media: index === 0 || index === 7 ? { type: "sample", label: index === 0 ? "Setup premium" : "Stream cut" } : null,
    poll: index === 5 ? {
      question: "¿Qué estilo gana esta semana?",
      options: [
        { text: "Cámara rápida", votes: ["u_nova"] },
        { text: "Cinemático", votes: ["u_byte", "u_aura"] },
        { text: "Sin edición", votes: [] }
      ]
    } : null,
    likes: index % 2 === 0 ? ["u_nova", "u_byte"] : ["u_aura"],
    comments: index < 3 ? [
      {
        id: uid("c"),
        userId: index === 0 ? "u_nova" : "u_aura",
        text: index === 0 ? "Ese acabado plateado se ve brutal." : "Lo guardo para probarlo luego.",
        createdAt: new Date(Date.now() - 1000 * 60 * (90 + index * 9)).toISOString(),
        edited: false,
        replies: []
      }
    ] : [],
    shares: index === 1 ? ["u_nova"] : [],
    savedBy: index === 1 ? ["u_demo"] : [],
    views: ["u_demo", "u_nova", "u_byte", "u_aura"],
    tags: extractTags(text),
    mentions: extractMentions(text),
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * (index + 4)).toISOString(),
    updatedAt: null
  }));

  posts.push(
    {
      id: "p_nova_1",
      userId: "u_nova",
      text: "Plantilla nueva para reels verticales. 9:16, subtítulos grandes y cortes más rápidos. #reels #edicion",
      media: { type: "sample", label: "Vertical template" },
      poll: null,
      likes: ["u_demo", "u_aura"],
      comments: [
        { id: uid("c"), userId: "u_demo", text: "La voy a guardar para el próximo clip.", createdAt: new Date(Date.now() - 1000 * 60 * 44).toISOString(), edited: false, replies: [] }
      ],
      shares: [],
      savedBy: ["u_demo"],
      views: ["u_demo", "u_nova", "u_aura"],
      tags: ["reels", "edicion"],
      mentions: [],
      createdAt: new Date(Date.now() - 1000 * 60 * 110).toISOString(),
      updatedAt: null
    },
    {
      id: "p_byte_1",
      userId: "u_byte",
      text: "¿Alguien más siente que el mapa nuevo premia demasiado el rush? #fps #ranked",
      media: null,
      poll: {
        question: "¿El mapa está balanceado?",
        options: [
          { text: "Sí", votes: [] },
          { text: "No", votes: ["u_demo"] },
          { text: "Necesita cambios", votes: ["u_nova", "u_aura"] }
        ]
      },
      likes: ["u_demo"],
      comments: [],
      shares: [],
      savedBy: [],
      views: ["u_demo", "u_byte"],
      tags: ["fps", "ranked"],
      mentions: [],
      createdAt: new Date(Date.now() - 1000 * 60 * 220).toISOString(),
      updatedAt: null
    }
  );

  const reels = [
    {
      id: "r_demo_1",
      userId: "u_demo",
      caption: "Ace clutch local. Pausa, volumen, guardar y compartir funcionando. #clutch",
      media: null,
      likes: ["u_nova", "u_byte", "u_aura"],
      comments: [{ id: uid("rc"), userId: "u_nova", text: "Ese último flick fue limpio.", createdAt: new Date(Date.now() - 1000 * 60 * 36).toISOString(), edited: false }],
      shares: ["u_aura"],
      savedBy: [],
      views: ["u_demo", "u_nova"],
      speed: 1,
      muted: true,
      createdAt: new Date(Date.now() - 1000 * 60 * 76).toISOString()
    },
    {
      id: "r_aura_1",
      userId: "u_aura",
      caption: "Intro para directo nocturno con estética premium. #streamer #setup",
      media: null,
      likes: ["u_demo", "u_nova"],
      comments: [],
      shares: [],
      savedBy: ["u_demo"],
      views: ["u_demo", "u_aura"],
      speed: 1,
      muted: true,
      createdAt: new Date(Date.now() - 1000 * 60 * 180).toISOString()
    }
  ];

  const conversations = [
    {
      id: "m_demo_nova",
      participants: ["u_demo", "u_nova"],
      messages: [
        { id: uid("m"), senderId: "u_nova", text: "¿Probaste el editor de perfil con vista previa?", media: null, createdAt: new Date(Date.now() - 1000 * 60 * 86).toISOString(), edited: false },
        { id: uid("m"), senderId: "u_demo", text: "Sí, queda listo para ajustar banner y bio sin guardar a ciegas.", media: null, createdAt: new Date(Date.now() - 1000 * 60 * 72).toISOString(), edited: false }
      ]
    },
    {
      id: "m_demo_byte",
      participants: ["u_demo", "u_byte"],
      messages: [
        { id: uid("m"), senderId: "u_byte", text: "Te mandé solicitud para jugar ranked.", media: null, createdAt: new Date(Date.now() - 1000 * 60 * 45).toISOString(), edited: false }
      ]
    }
  ];

  return {
    version: "1.0-final",
    createdAt: now(),
    updatedAt: now(),
    users,
    posts,
    reels,
    conversations,
    notifications: [
      notification("u_demo", "like", "Nova Pixel dio like a tu publicación.", "u_nova", "p_demo_1", true),
      notification("u_demo", "friend", "Byte Rush te envió una solicitud de amistad.", "u_byte", null, false),
      notification("u_demo", "verify", "Tu cuenta obtuvo verificación azul por llegar a 10 publicaciones.", "system", null, true)
    ],
    reports: []
  };
}

function seedDatabase() {
  return emptyDatabase();
}

function notification(userId, type, text, actorId = "system", entityId = null, read = false) {
  return {
    id: uid("n"),
    userId,
    type,
    text,
    actorId,
    entityId,
    read,
    createdAt: now()
  };
}

function getSession() {
  return localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY) || "";
}

function setSession(userId, remember = true) {
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  if (remember) localStorage.setItem(SESSION_KEY, userId);
  else sessionStorage.setItem(SESSION_KEY, userId);
  state.currentUserId = userId;
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  state.currentUserId = null;
}

function currentUser() {
  return userById(state.currentUserId);
}

function userById(id) {
  return db.users.find((user) => user.id === id) || null;
}

function userByUsername(username) {
  const clean = cleanUsername(username);
  return db.users.find((user) => user.username === clean) || null;
}

function postById(id) {
  return db.posts.find((post) => post.id === id) || null;
}

function reelById(id) {
  return db.reels.find((reel) => reel.id === id) || null;
}

function conversationById(id) {
  return db.conversations.find((conversation) => conversation.id === id) || null;
}

function extractTags(text = "") {
  return [...new Set([...String(text).matchAll(/#([A-Za-z0-9_À-ÿ]+)/g)].map((match) => match[1].toLowerCase()))];
}

function extractMentions(text = "") {
  return [...new Set([...String(text).matchAll(/@([A-Za-z0-9._À-ÿ]+)/g)].map((match) => cleanUsername(match[1])))];
}

function richText(text = "") {
  const safe = escapeHtml(text);
  return safe
    .replace(/#([A-Za-z0-9_À-ÿ]+)/g, '<button class="tag-link" type="button" data-tag="$1">#$1</button>')
    .replace(/@([A-Za-z0-9._À-ÿ]+)/g, '<button class="mention-link" type="button" data-mention="$1">@$1</button>');
}

function calculateLevel(xp = 0) {
  let level = 1;
  while (xp >= xpForLevel(level + 1)) level += 1;
  return level;
}

function xpForLevel(level) {
  if (level <= 1) return 0;
  const fixed = { 2: 100, 3: 250, 4: 500, 5: 1000 };
  if (fixed[level]) return fixed[level];
  let xp = 1000;
  for (let step = 6; step <= level; step += 1) {
    xp += 650 + (step - 6) * 250;
  }
  return xp;
}

function xpProgress(user) {
  const level = calculateLevel(user.xp);
  const current = xpForLevel(level);
  const next = xpForLevel(level + 1);
  const pct = Math.max(0, Math.min(100, ((user.xp - current) / (next - current)) * 100));
  return { level, current, next, pct };
}

function userStats(userId) {
  const user = userById(userId);
  const posts = db.posts.filter((post) => post.userId === userId);
  const reels = db.reels.filter((reel) => reel.userId === userId);
  return {
    posts: posts.length,
    reels: reels.length,
    friends: user?.friends.length || 0,
    followers: user?.followers.length || 0,
    following: user?.following.length || 0,
    likes: posts.reduce((sum, post) => sum + post.likes.length, 0) + reels.reduce((sum, reel) => sum + reel.likes.length, 0),
    comments: posts.reduce((sum, post) => sum + post.comments.length + post.comments.reduce((nested, c) => nested + (c.replies?.length || 0), 0), 0) + reels.reduce((sum, reel) => sum + reel.comments.length, 0),
    saved: (user?.savedPosts.length || 0) + (user?.savedReels.length || 0),
    views: posts.reduce((sum, post) => sum + post.views.length, 0) + reels.reduce((sum, reel) => sum + reel.views.length, 0)
  };
}

function syncAllUsers(shouldSave = true) {
  db.users.forEach((user) => syncUser(user.id, false));
  if (shouldSave) saveDatabase();
}

function syncUser(userId, notifyChanges = true) {
  const user = userById(userId);
  if (!user) return;
  const stats = userStats(userId);
  const previousVerification = user.verified || "normal";
  user.level = calculateLevel(user.xp || 0);
  user.verified = stats.posts >= 100 ? "gold" : stats.posts >= 10 ? "blue" : "normal";
  const achievements = new Set(user.achievements || []);
  if (stats.posts > 0) achievements.add("🥇 Primera publicación");
  if (stats.reels > 0) achievements.add("🎥 Primer Reel");
  if (db.posts.some((post) => post.comments.some((comment) => comment.userId === userId || comment.replies?.some((reply) => reply.userId === userId))) || db.reels.some((reel) => reel.comments.some((comment) => comment.userId === userId))) achievements.add("💬 Primer comentario");
  if (stats.likes >= 100) achievements.add("❤️ 100 Likes");
  if (stats.likes >= 1000) achievements.add("🔥 1000 Likes");
  if (user.verified === "blue" || user.verified === "gold") achievements.add("⭐ Verificado");
  if (user.verified === "gold") achievements.add("👑 Verificado Dorado");
  if (stats.posts >= 100) achievements.add("🚀 100 Publicaciones");
  if (stats.followers >= 500) achievements.add("🏅 500 Seguidores");
  user.achievements = [...achievements];
  if (notifyChanges && previousVerification !== user.verified && user.verified !== "normal") {
    const label = user.verified === "gold" ? "verificación dorada" : "verificación azul";
    pushNotification(user.id, "verify", `Tu cuenta obtuvo ${label}.`, "system", null);
  }
}

function awardXP(userId, amount, reason = "actividad") {
  const user = userById(userId);
  if (!user) return;
  const oldLevel = calculateLevel(user.xp || 0);
  user.xp = (user.xp || 0) + amount;
  const newLevel = calculateLevel(user.xp);
  user.level = newLevel;
  if (newLevel > oldLevel) {
    pushNotification(user.id, "level", `Subiste a nivel ${newLevel} por ${reason}.`, "system", null);
  }
  syncUser(userId);
}

function pushNotification(userId, type, text, actorId = state.currentUserId || "system", entityId = null) {
  if (!userById(userId)) return;
  db.notifications.unshift(notification(userId, type, text, actorId, entityId, false));
}

function toast(title, text = "") {
  const stack = $("#toastStack");
  const item = document.createElement("div");
  item.className = "toast";
  item.innerHTML = `<strong>${escapeHtml(title)}</strong>${text ? `<span>${escapeHtml(text)}</span>` : ""}`;
  stack.appendChild(item);
  setTimeout(() => item.remove(), 3600);
}

function avatarHtml(user, size = "avatar") {
  if (!user) return `<span class="${size}">BF</span>`;
  return `<span class="${size}">${user.avatar ? `<img src="${user.avatar}" alt="">` : escapeHtml(initials(user.name))}</span>`;
}

function verifyHtml(user) {
  if (!user || user.verified === "normal") return `<span class="verify-pill">⚪ Normal</span>`;
  if (user.verified === "gold") return `<span class="verify-pill verify-gold">🟡 Dorado</span>`;
  return `<span class="verify-pill verify-blue">🔵 Verificado</span>`;
}

function badgesHtml(user) {
  const badges = user?.badges?.length ? user.badges : ["⭐ Gamer"];
  return `<div class="badge-row">${badges.map((badge) => `<span class="badge">${escapeHtml(badge)}</span>`).join("")}</div>`;
}

function render() {
  const logged = Boolean(state.currentUserId && currentUser());
  $("#authScreen").classList.toggle("is-hidden", logged);
  $("#appShell").classList.toggle("is-hidden", !logged);
  if (!logged) return;
  $("#appShell").classList.toggle("focus-mode", state.focusMode);
  renderNav();
  renderTopbar();
  renderRightRail();
  renderView();
}

function renderNav() {
  const html = navItems.map((item) => navButtonHtml(item)).join("");
  $("#primaryNav").innerHTML = html;
  $("#mobileNav").innerHTML = navItems.slice(0, 5).map((item) => navButtonHtml(item)).join("");
}

function navButtonHtml(item) {
  const active = state.view === item.id ? "is-active" : "";
  return `
    <button class="nav-item ${active}" type="button" data-view="${item.id}">
      <span class="nav-icon">${item.icon}</span>
      <span>${item.label}</span>
    </button>
  `;
}

function renderTopbar() {
  const user = currentUser();
  const nav = navItems.find((item) => item.id === state.view) || navItems[0];
  $("#viewKicker").textContent = nav.kicker;
  $("#viewTitle").textContent = nav.title;
  const topAvatar = $("#topAvatar");
  if (topAvatar) {
    topAvatar.innerHTML = user.avatar ? `<img src="${user.avatar}" alt="">` : escapeHtml(initials(user.name));
  }
  $("#topUsername").textContent = `@${user.username}`;
  $("#notificationDot").textContent = unreadNotifications().length;
  $("#globalSearch").value = state.search;
}

function renderRightRail() {
  const user = currentUser();
  const stats = userStats(user.id);
  const progress = xpProgress(user);
  $("#rightRail").innerHTML = `
    <section class="panel mini-profile">
      <div class="mini-profile-top">
        ${avatarHtml(user, "avatar")}
        <div class="user-lines">
          <strong>${escapeHtml(user.name)}</strong>
          <small>@${escapeHtml(user.username)}</small>
        </div>
      </div>
      ${verifyHtml(user)}
      <div class="level-bar" style="--level:${progress.pct}%"><span></span></div>
      <small class="muted">Nivel ${progress.level} · ${user.xp} XP · próximo ${progress.next} XP</small>
      <div class="compact-stats">
        ${statPill(stats.posts, "Posts")}
        ${statPill(stats.followers, "Seguidores")}
        ${statPill(stats.likes, "Likes")}
      </div>
    </section>

    <section id="serverStatus" class="panel">
      ${serverStatusInnerHtml()}
    </section>

    <section class="panel">
      <div class="section-title">
        <div>
          <h3>Actividad</h3>
          <p>Resumen local</p>
        </div>
      </div>
      ${activitySparkHtml()}
      <div class="activity-list">
        <p>Publicaciones: <strong>${stats.posts}</strong></p>
        <p>Reels: <strong>${stats.reels}</strong></p>
        <p>Comentarios recibidos: <strong>${stats.comments}</strong></p>
      </div>
    </section>

    <section class="panel">
      <div class="section-title">
        <div>
          <h3>Notificaciones</h3>
          <p>${unreadNotifications().length} sin leer</p>
        </div>
        <button class="mini-btn" type="button" data-view="notifications">Ver</button>
      </div>
      <div class="notification-list">
        ${notificationsForCurrent().slice(0, 4).map(notificationHtml).join("") || emptyMini("Sin notificaciones todavía.")}
      </div>
    </section>

    <section class="panel">
      <div class="section-title">
        <div>
          <h3>Tendencias</h3>
          <p>Hashtags activos</p>
        </div>
      </div>
      <div class="trend-list">
        ${trendingTags().slice(0, 6).map(([tag, count]) => `<button class="mini-btn" type="button" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)} · ${count}</button>`).join("") || emptyMini("Publica hashtags para ver tendencias.")}
      </div>
    </section>
  `;
}

function serverStatusInnerHtml() {
  const label = state.serverOnline ? "Online" : "Pendiente";
  const marker = state.serverOnline ? "●" : "○";
  return `
    <div class="section-title">
      <div>
        <h3>Supabase</h3>
        <p>${marker} ${escapeHtml(label)} · ${escapeHtml(state.serverMessage)}</p>
      </div>
    </div>
    <p class="muted">${escapeHtml(state.serverUrl || "Sin URL de Supabase")}</p>
    <div class="inline-actions">
      <button class="mini-btn" type="button" data-action="sync-now">Sync</button>
    </div>
  `;
}

function renderView() {
  const root = $("#viewRoot");
  const views = {
    feed: renderFeed,
    reels: renderReels,
    messages: renderMessages,
    friends: renderFriends,
    search: renderSearch,
    saved: renderSaved,
    stats: renderStats,
    settings: renderSettings,
    profile: renderProfile,
    notifications: renderNotifications
  };
  root.innerHTML = `${state.focusMode ? `<button class="soft-btn focus-exit-btn" type="button" data-action="exit-focus">Salir de concentraciÃ³n</button>` : ""}${(views[state.view] || renderFeed)()}`;
  afterRender();
}

function statPill(value, label) {
  return `<div class="stat-pill"><strong>${value}</strong><span>${label}</span></div>`;
}

function emptyState(text) {
  return `<div class="empty-state">${escapeHtml(text)}</div>`;
}

function emptyMini(text) {
  return `<p class="muted">${escapeHtml(text)}</p>`;
}

function activitySparkHtml() {
  const user = currentUser();
  const stats = userStats(user.id);
  const values = [stats.posts, stats.reels, stats.likes, stats.comments, stats.followers, stats.following, stats.friends, stats.views].map((value) => Math.max(10, Math.min(100, value * 8 + 12)));
  return `<div class="activity-spark">${values.map((value) => `<span style="--h:${value}%"></span>`).join("")}</div>`;
}

function renderFeed() {
  const posts = sortedPosts().filter((post) => !state.activeTag || post.tags.includes(state.activeTag));
  posts.slice(0, state.feedLimit).forEach((post) => markViewed(post, "post"));
  const visible = posts.slice(0, state.feedLimit);
  return `
    <div class="view-grid">
      ${composerHtml()}
      ${state.activeTag ? `
        <section class="panel">
          <div class="section-title">
            <div>
              <h2>#${escapeHtml(state.activeTag)}</h2>
              <p>Filtro activo del feed</p>
            </div>
            <button class="mini-btn" type="button" data-action="clear-tag">Limpiar</button>
          </div>
        </section>
      ` : ""}
      <section class="view-grid">
        ${visible.map(renderPost).join("") || emptyState("Todavía no hay publicaciones con ese filtro.")}
      </section>
      ${posts.length > state.feedLimit ? `<button class="soft-btn" type="button" data-action="load-more-feed">Cargar más</button>` : ""}
    </div>
  `;
}

function composerHtml() {
  const user = currentUser();
  return `
    <form id="postComposer" class="composer">
      <div class="composer-head">
        ${avatarHtml(user, "avatar")}
        <div class="user-lines">
          <strong>Crear publicación</strong>
          <small>Texto, imagen, video, GIF, encuesta, #hashtags y @menciones</small>
        </div>
      </div>
      <textarea id="postText" placeholder="¿Qué estás jugando o creando hoy?"></textarea>
      <div id="postPreview" class="media-preview is-hidden"></div>
      <div class="poll-builder">
        <strong>Encuesta opcional</strong>
        <input id="pollQuestion" type="text" placeholder="Pregunta de la encuesta" />
        <textarea id="pollOptions" placeholder="Opciones, una por línea"></textarea>
      </div>
      <div class="composer-tools">
        <div class="tool-group">
          <label class="file-pill">▧ Imagen / Video / GIF
            <input id="postMedia" type="file" accept="image/*,video/*,.gif" />
          </label>
          <button class="mini-btn" type="button" data-action="insert-sample-tags"># @</button>
        </div>
        <button class="primary-btn" type="submit">Publicar</button>
      </div>
    </form>
  `;
}

function sortedPosts() {
  return [...db.posts].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function renderPost(post) {
  const author = userById(post.userId);
  const user = currentUser();
  const liked = post.likes.includes(user.id);
  const saved = user.savedPosts.includes(post.id);
  const canEdit = post.userId === user.id;
  const comments = post.comments.map((comment) => renderComment(post, comment)).join("");
  return `
    <article class="post-card" data-post-id="${post.id}">
      <header class="post-head">
        <button class="post-author" type="button" data-profile="${author.id}">
          ${avatarHtml(author, "avatar")}
          <span class="user-lines">
            <strong>${escapeHtml(author.name)} ${inlineVerify(author)}</strong>
            <small>@${escapeHtml(author.username)} · ${formatDate(post.createdAt)} · ${post.views.length} vistas</small>
          </span>
        </button>
        <div class="post-menu">
          <button class="mini-btn" type="button" data-action="view-likes" data-post-id="${post.id}">Likes</button>
          ${canEdit ? `<button class="mini-btn" type="button" data-action="edit-post" data-post-id="${post.id}">Editar</button>` : ""}
          ${canEdit ? `<button class="mini-btn is-danger" type="button" data-action="delete-post" data-post-id="${post.id}">Eliminar</button>` : ""}
          <button class="mini-btn" type="button" data-action="report-post" data-post-id="${post.id}">Reportar</button>
        </div>
      </header>
      ${post.text ? `<p class="post-text">${richText(post.text)}</p>` : ""}
      ${renderMedia(post.media)}
      ${renderPoll(post)}
      <div class="action-row">
        <button class="mini-btn ${liked ? "is-on" : ""}" type="button" data-action="like-post" data-post-id="${post.id}">❤️ ${post.likes.length}</button>
        <button class="mini-btn" type="button" data-action="focus-comment" data-post-id="${post.id}">💬 ${post.comments.length}</button>
        <button class="mini-btn" type="button" data-action="share-post" data-post-id="${post.id}">📤 ${post.shares.length}</button>
        <button class="mini-btn ${saved ? "is-on" : ""}" type="button" data-action="save-post" data-post-id="${post.id}">▣ Guardar</button>
      </div>
      <div class="comment-box">
        <div class="comment-list">${comments || `<p class="muted">Sé la primera persona en comentar.</p>`}</div>
        <form class="inline-actions comment-form" data-post-id="${post.id}">
          <input type="text" name="comment" placeholder="Comentar o responder con buena vibra" />
          <button class="soft-btn" type="submit">Comentar</button>
        </form>
      </div>
    </article>
  `;
}

function inlineVerify(user) {
  if (!user || user.verified === "normal") return "";
  return user.verified === "gold" ? `<span title="Verificado dorado">🟡</span>` : `<span title="Verificado">🔵</span>`;
}

function renderComment(post, comment) {
  const author = userById(comment.userId);
  const canEdit = comment.userId === currentUser().id;
  return `
    <div class="comment-row" data-comment-id="${comment.id}">
      ${avatarHtml(author, "avatar-mini")}
      <div class="user-lines">
        <strong>${escapeHtml(author?.name || "Usuario")}</strong>
        <small>${formatDate(comment.createdAt)}${comment.edited ? " · editado" : ""}</small>
        <p>${richText(comment.text)}</p>
        <div class="inline-actions">
          <button class="mini-btn" type="button" data-action="reply-comment" data-post-id="${post.id}" data-comment-id="${comment.id}">Responder</button>
          ${canEdit ? `<button class="mini-btn" type="button" data-action="edit-comment" data-post-id="${post.id}" data-comment-id="${comment.id}">Editar</button>` : ""}
          ${canEdit ? `<button class="mini-btn is-danger" type="button" data-action="delete-comment" data-post-id="${post.id}" data-comment-id="${comment.id}">Eliminar</button>` : ""}
        </div>
        ${(comment.replies || []).map((reply) => renderReply(post, comment, reply)).join("")}
      </div>
    </div>
  `;
}

function renderReply(post, comment, reply) {
  const author = userById(reply.userId);
  const canEdit = reply.userId === currentUser().id;
  return `
    <div class="comment-row" data-reply-id="${reply.id}">
      ${avatarHtml(author, "avatar-mini")}
      <div class="user-lines">
        <strong>${escapeHtml(author?.name || "Usuario")}</strong>
        <small>${formatDate(reply.createdAt)}${reply.edited ? " · editado" : ""}</small>
        <p>${richText(reply.text)}</p>
        <div class="inline-actions">
          ${canEdit ? `<button class="mini-btn" type="button" data-action="edit-reply" data-post-id="${post.id}" data-comment-id="${comment.id}" data-reply-id="${reply.id}">Editar</button>` : ""}
          ${canEdit ? `<button class="mini-btn is-danger" type="button" data-action="delete-reply" data-post-id="${post.id}" data-comment-id="${comment.id}" data-reply-id="${reply.id}">Eliminar</button>` : ""}
        </div>
      </div>
    </div>
  `;
}

function renderMedia(media) {
  if (!media) return "";
  if (media.type === "sample") {
    return `<div class="post-media sample-shot"><strong>${escapeHtml(media.label || "BlackFrame media")}</strong><span class="muted">Vista multimedia simulada</span></div>`;
  }
  if (media.type === "video") {
    return `<div class="post-media"><video src="${media.data}" controls playsinline></video></div>`;
  }
  if (media.type === "image" || media.type === "gif") {
    return `<div class="post-media"><img src="${media.data}" alt="${escapeHtml(media.name || "Multimedia")}"></div>`;
  }
  return media.name ? `<div class="post-media sample-shot"><strong>${escapeHtml(media.name)}</strong><span class="muted">Archivo simulado</span></div>` : "";
}

function renderPoll(post) {
  if (!post.poll) return "";
  const total = post.poll.options.reduce((sum, option) => sum + option.votes.length, 0);
  return `
    <div class="poll-box">
      <strong>${escapeHtml(post.poll.question)}</strong>
      ${post.poll.options.map((option, index) => {
        const pct = total ? Math.round((option.votes.length / total) * 100) : 0;
        const voted = option.votes.includes(currentUser().id);
        return `
          <button class="poll-option ${voted ? "is-on" : ""}" type="button" data-action="vote-poll" data-post-id="${post.id}" data-option="${index}">
            <span class="poll-fill" style="--w:${pct}%"></span>
            <span>${escapeHtml(option.text)}</span>
            <b>${pct}%</b>
          </button>
        `;
      }).join("")}
      <small class="muted">${total} votos</small>
    </div>
  `;
}

function renderProfile() {
  const id = state.activeProfileId || currentUser().id;
  const user = userById(id) || currentUser();
  const stats = userStats(user.id);
  const progress = xpProgress(user);
  const isMe = user.id === currentUser().id;
  return `
    <div class="view-grid">
      <section class="profile-hero">
        <div class="profile-banner">${user.banner ? `<img src="${user.banner}" alt="">` : ""}</div>
        <div class="profile-body">
          <div class="profile-main">
            ${avatarHtml(user, "avatar-lg")}
            <div>
              <div class="profile-name-row">
                <h2>${escapeHtml(user.name)}</h2>
                ${verifyHtml(user)}
              </div>
              <p class="muted">@${escapeHtml(user.username)} · ${escapeHtml(user.country)}${user.city ? `, ${escapeHtml(user.city)}` : ""} · creado ${formatDate(user.createdAt)}</p>
              <p class="profile-bio">${escapeHtml(user.bio || "Sin biografía todavía.")}</p>
              ${badgesHtml(user)}
              <div class="profile-actions">
                ${isMe ? `<button class="primary-btn" type="button" data-view="settings">Editar perfil</button>` : socialButtonsHtml(user)}
              </div>
            </div>
          </div>
          <div class="stat-grid">
            ${statPill(stats.posts, "Publicaciones")}
            ${statPill(stats.reels, "Reels")}
            ${statPill(stats.friends, "Amigos")}
            ${statPill(stats.followers, "Seguidores")}
            ${statPill(stats.following, "Siguiendo")}
            ${statPill(stats.likes, "Likes recibidos")}
            ${statPill(stats.comments, "Comentarios")}
            ${statPill(progress.level, "Nivel")}
            ${statPill(user.xp, "Experiencia")}
          </div>
          <div class="level-bar" style="--level:${progress.pct}%"><span></span></div>
          <small class="muted">Siguiente nivel: ${progress.next} XP</small>
        </div>
      </section>
      <div class="tabs">
        ${["posts", "reels", "gallery", "friends", "followers", "following", "achievements"].map((tab) => `
          <button class="tab-btn ${state.profileTab === tab ? "is-active" : ""}" type="button" data-action="profile-tab" data-tab="${tab}">${profileTabLabel(tab)}</button>
        `).join("")}
      </div>
      <section class="view-grid">${renderProfileTab(user)}</section>
    </div>
  `;
}

function profileTabLabel(tab) {
  return {
    posts: "Publicaciones",
    reels: "Reels",
    gallery: "Galería",
    friends: "Amigos",
    followers: "Seguidores",
    following: "Siguiendo",
    achievements: "Logros"
  }[tab] || tab;
}

function renderProfileTab(user) {
  if (state.profileTab === "posts") {
    const posts = sortedPosts().filter((post) => post.userId === user.id);
    return posts.map(renderPost).join("") || emptyState("Este perfil aún no tiene publicaciones.");
  }
  if (state.profileTab === "reels") {
    const reels = sortedReels().filter((reel) => reel.userId === user.id);
    return reels.map(renderReelCard).join("") || emptyState("Este perfil aún no tiene reels.");
  }
  if (state.profileTab === "gallery") return galleryHtml(user.id);
  if (state.profileTab === "friends") return peopleCards(user.friends, "Sin amigos visibles.");
  if (state.profileTab === "followers") return peopleCards(user.followers, "Sin seguidores todavía.");
  if (state.profileTab === "following") return peopleCards(user.following, "No sigue a nadie todavía.");
  return `
    <section class="panel">
      <div class="section-title">
        <div>
          <h2>Logros e insignias</h2>
          <p>Aparecen automáticamente según tu actividad.</p>
        </div>
      </div>
      <div class="achievement-grid">
        ${(user.achievements || []).map((achievement) => `<span class="badge">${escapeHtml(achievement)}</span>`).join("") || `<span class="muted">Sigue creando para desbloquear logros.</span>`}
      </div>
    </section>
  `;
}

function galleryHtml(userId) {
  const media = [
    ...db.posts.filter((post) => post.userId === userId && post.media).map((post) => post.media),
    ...db.reels.filter((reel) => reel.userId === userId && reel.media).map((reel) => reel.media)
  ];
  if (!media.length) return emptyState("La galería multimedia aparecerá cuando subas imágenes, videos o GIF.");
  return `<div class="gallery-grid">${media.map((item) => `
    <div class="gallery-tile">
      ${item.type === "video" ? `<video src="${item.data}" controls playsinline></video>` : `<img src="${item.data}" alt="${escapeHtml(item.name || "Media")}">`}
    </div>
  `).join("")}</div>`;
}

function peopleCards(ids, emptyText) {
  const cards = ids.map(userById).filter(Boolean).map((user) => `
    <article class="friend-card">
      <div class="mini-user">
        ${avatarHtml(user, "avatar")}
        <div class="user-lines">
          <strong>${escapeHtml(user.name)} ${inlineVerify(user)}</strong>
          <small>@${escapeHtml(user.username)}</small>
        </div>
      </div>
      <p class="muted">${escapeHtml(user.bio || "Perfil BlackFrame.")}</p>
      <div class="inline-actions">
        <button class="mini-btn" type="button" data-profile="${user.id}">Ver perfil</button>
        ${user.id !== currentUser().id ? socialButtonsHtml(user, true) : ""}
      </div>
    </article>
  `).join("");
  return cards ? `<div class="friends-grid">${cards}</div>` : emptyState(emptyText);
}

function socialButtonsHtml(target, compact = false) {
  const me = currentUser();
  const following = me.following.includes(target.id);
  const friends = me.friends.includes(target.id);
  const sent = me.requestsOut.includes(target.id);
  const received = me.requestsIn.includes(target.id);
  const mutual = me.friends.filter((id) => target.friends.includes(id)).length;
  const sizeClass = compact ? "mini-btn" : "soft-btn";
  if (friends) {
    return `
      <button class="${sizeClass}" type="button" data-action="unfollow" data-user-id="${target.id}">${following ? "Dejar de seguir" : "Seguir"}</button>
      <button class="${sizeClass} is-danger" type="button" data-action="remove-friend" data-user-id="${target.id}">Eliminar amigo</button>
      <span class="badge">${mutual} amigos en común</span>
    `;
  }
  if (received) {
    return `
      <button class="${sizeClass}" type="button" data-action="accept-friend" data-user-id="${target.id}">Aceptar</button>
      <button class="${sizeClass} is-danger" type="button" data-action="reject-friend" data-user-id="${target.id}">Rechazar</button>
      <button class="${sizeClass}" type="button" data-action="${following ? "unfollow" : "follow"}" data-user-id="${target.id}">${following ? "Dejar de seguir" : "Seguir"}</button>
    `;
  }
  return `
    <button class="${sizeClass}" type="button" data-action="${following ? "unfollow" : "follow"}" data-user-id="${target.id}">${following ? "Dejar de seguir" : "Seguir"}</button>
    <button class="${sizeClass}" type="button" data-action="${sent ? "cancel-friend" : "send-friend"}" data-user-id="${target.id}">${sent ? "Cancelar solicitud" : "Enviar solicitud"}</button>
    <span class="badge">${mutual} amigos en común</span>
  `;
}

function renderReels() {
  sortedReels().forEach((reel) => markViewed(reel, "reel"));
  return `
    <button class="soft-btn reels-back-btn" type="button" data-view="feed">AtrÃ¡s</button>
    <div class="reels-layout">
      <section class="reel-feed">
        ${sortedReels().map(renderReelCard).join("") || emptyState("Sube el primer reel vertical.")}
      </section>
      <aside class="panel">
        <div class="section-title">
          <div>
            <h2>Subir Reel</h2>
            <p>Video vertical con likes, comentarios, velocidad y pantalla completa.</p>
          </div>
        </div>
        <form id="reelForm" class="auth-form">
          <label>Video
            <input id="reelVideo" type="file" accept="video/*" />
          </label>
          <label>Descripción
            <textarea id="reelCaption" placeholder="Describe tu clip con #hashtags y @menciones"></textarea>
          </label>
          <button class="primary-btn" type="submit">Publicar reel</button>
        </form>
      </aside>
    </div>
  `;
}

function sortedReels() {
  return [...db.reels].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function renderReelCard(reel) {
  const author = userById(reel.userId);
  const user = currentUser();
  const liked = reel.likes.includes(user.id);
  const saved = user.savedReels.includes(reel.id);
  return `
    <article class="reel-card" data-reel-id="${reel.id}">
      <div class="reel-stage">
        ${reel.media ? `<video src="${reel.media.data}" playsinline loop muted="${reel.muted !== false}" data-reel-video="${reel.id}"></video>` : `<div class="reel-placeholder"><strong>BLACKFRAME REEL</strong><span class="muted">Video simulado local</span></div>`}
        <div class="reel-caption">
          <button class="mini-user" type="button" data-profile="${author.id}">
            ${avatarHtml(author, "avatar-mini")}
            <span class="user-lines">
              <strong>${escapeHtml(author.name)} ${inlineVerify(author)}</strong>
              <small>@${escapeHtml(author.username)} · ${reel.views.length} vistas</small>
            </span>
          </button>
          <p>${richText(reel.caption || "")}</p>
        </div>
      </div>
      <div class="reel-actions">
        <button class="mini-btn ${liked ? "is-on" : ""}" type="button" data-action="like-reel" data-reel-id="${reel.id}" title="Like">❤️<span>${reel.likes.length}</span></button>
        <button class="mini-btn" type="button" data-action="comment-reel" data-reel-id="${reel.id}" title="Comentar">💬<span>${reel.comments.length}</span></button>
        <button class="mini-btn" type="button" data-action="share-reel" data-reel-id="${reel.id}" title="Compartir">📤</button>
        <button class="mini-btn ${saved ? "is-on" : ""}" type="button" data-action="save-reel" data-reel-id="${reel.id}" title="Guardar">▣</button>
        <button class="mini-btn" type="button" data-action="pause-reel" data-reel-id="${reel.id}" title="Pausar">Ⅱ</button>
        <button class="mini-btn" type="button" data-action="volume-reel" data-reel-id="${reel.id}" title="Volumen">◉</button>
        <button class="mini-btn" type="button" data-action="speed-reel" data-reel-id="${reel.id}" title="Velocidad">${reel.speed || 1}x</button>
        <button class="mini-btn" type="button" data-action="fullscreen-reel" data-reel-id="${reel.id}" title="Pantalla completa">⛶</button>
      </div>
    </article>
  `;
}

function renderMessages() {
  const conversations = db.conversations.filter((conversation) => conversation.participants.includes(currentUser().id));
  if (!state.selectedConversationId && conversations[0]) state.selectedConversationId = conversations[0].id;
  const selected = conversationById(state.selectedConversationId) || conversations[0];
  const filtered = conversations.filter((conversation) => {
    const other = otherParticipant(conversation);
    return !state.messageSearch || other?.name.toLowerCase().includes(state.messageSearch.toLowerCase()) || other?.username.includes(state.messageSearch.toLowerCase());
  });
  return `
    <div class="messages-layout">
      <aside class="panel conversation-list">
        <input id="conversationSearch" type="search" placeholder="Buscar conversación" value="${escapeHtml(state.messageSearch)}" />
        <div class="conversation-items">
          ${filtered.map((conversation) => conversationCard(conversation)).join("") || emptyMini("Sin conversaciones.")}
        </div>
      </aside>
      <section class="panel chat-window">
        ${selected ? chatHtml(selected) : emptyState("Selecciona una conversación para empezar.")}
      </section>
    </div>
  `;
}

function otherParticipant(conversation) {
  return userById(conversation.participants.find((id) => id !== currentUser().id));
}

function conversationCard(conversation) {
  const other = otherParticipant(conversation);
  const last = conversation.messages.at(-1);
  return `
    <button class="conversation-card ${state.selectedConversationId === conversation.id ? "is-active" : ""}" type="button" data-action="select-conversation" data-conversation-id="${conversation.id}">
      ${avatarHtml(other, "avatar")}
      <span class="user-lines">
        <strong>${escapeHtml(other?.name || "Chat")}</strong>
        <small>${last ? escapeHtml(last.text || last.media?.name || "Archivo") : "Sin mensajes"}</small>
      </span>
    </button>
  `;
}

function chatHtml(conversation) {
  const other = otherParticipant(conversation);
  return `
    <header class="chat-head">
      ${avatarHtml(other, "avatar")}
      <div class="user-lines">
        <strong>${escapeHtml(other?.name || "Chat privado")}</strong>
        <small>@${escapeHtml(other?.username || "usuario")} · ${state.typing ? "escribiendo..." : other?.status || "Online"}</small>
      </div>
    </header>
    <div class="message-stream">
      ${conversation.messages.map(messageHtml).join("") || emptyMini("Aún no hay mensajes.")}
    </div>
    <form id="messageComposer" class="message-composer" data-conversation-id="${conversation.id}">
      <label class="file-pill">▧
        <input id="messageFile" type="file" />
      </label>
      <textarea id="messageText" placeholder="Escribe un mensaje, emoji o adjunta un archivo"></textarea>
      <button class="primary-btn" type="submit">Enviar</button>
    </form>
  `;
}

function messageHtml(message) {
  const me = message.senderId === currentUser().id;
  return `
    <div class="message-bubble ${me ? "is-me" : ""}" data-message-id="${message.id}">
      ${message.text ? `<p>${richText(message.text)}</p>` : ""}
      ${message.media ? messageMediaHtml(message.media) : ""}
      <small>${formatDate(message.createdAt)}${message.edited ? " · editado" : ""}</small>
      ${me ? `
        <div class="inline-actions">
          <button class="mini-btn" type="button" data-action="edit-message" data-message-id="${message.id}">Editar</button>
          <button class="mini-btn is-danger" type="button" data-action="delete-message" data-message-id="${message.id}">Eliminar</button>
        </div>
      ` : ""}
    </div>
  `;
}

function messageMediaHtml(media) {
  if (media.type === "image" || media.type === "gif") return `<img src="${media.data}" alt="${escapeHtml(media.name || "Imagen")}">`;
  if (media.type === "video") return `<video src="${media.data}" controls playsinline></video>`;
  return `<p><strong>Archivo:</strong> ${escapeHtml(media.name || "adjunto simulado")}</p>`;
}

function renderFriends() {
  const me = currentUser();
  const suggestions = db.users.filter((user) => user.id !== me.id && !me.friends.includes(user.id) && !me.requestsOut.includes(user.id) && !me.requestsIn.includes(user.id));
  return `
    <div class="view-grid">
      <section class="panel">
        <div class="section-title">
          <div>
            <h2>Solicitudes</h2>
            <p>Enviar, cancelar, aceptar o rechazar solicitudes.</p>
          </div>
        </div>
        <div class="friends-grid">
          ${peopleRequestCards(me.requestsIn, "incoming") || emptyState("No tienes solicitudes entrantes.")}
          ${peopleRequestCards(me.requestsOut, "outgoing") || ""}
        </div>
      </section>
      <section class="panel">
        <div class="section-title"><h2>Amigos</h2><p>${me.friends.length} conexiones</p></div>
        ${peopleCards(me.friends, "Aún no agregas amigos.")}
      </section>
      <section class="panel">
        <div class="section-title"><h2>Sugerencias</h2><p>Personas en BlackFrame</p></div>
        <div class="friends-grid">${suggestions.map((user) => `
          <article class="friend-card">
            <div class="mini-user">${avatarHtml(user, "avatar")}<div class="user-lines"><strong>${escapeHtml(user.name)} ${inlineVerify(user)}</strong><small>@${escapeHtml(user.username)}</small></div></div>
            <p class="muted">${escapeHtml(user.bio)}</p>
            <div class="inline-actions">${socialButtonsHtml(user, true)}<button class="mini-btn" type="button" data-profile="${user.id}">Perfil</button></div>
          </article>
        `).join("") || emptyState("No hay más sugerencias.")}</div>
      </section>
    </div>
  `;
}

function peopleRequestCards(ids, mode) {
  return ids.map(userById).filter(Boolean).map((user) => `
    <article class="friend-card">
      <div class="mini-user">${avatarHtml(user, "avatar")}<div class="user-lines"><strong>${escapeHtml(user.name)}</strong><small>@${escapeHtml(user.username)}</small></div></div>
      <p class="muted">${mode === "incoming" ? "Quiere ser tu amigo." : "Solicitud enviada."}</p>
      <div class="inline-actions">
        ${mode === "incoming"
          ? `<button class="mini-btn" type="button" data-action="accept-friend" data-user-id="${user.id}">Aceptar</button><button class="mini-btn is-danger" type="button" data-action="reject-friend" data-user-id="${user.id}">Rechazar</button>`
          : `<button class="mini-btn is-danger" type="button" data-action="cancel-friend" data-user-id="${user.id}">Cancelar</button>`}
      </div>
    </article>
  `).join("");
}

function renderSearch() {
  const query = state.search.trim().toLowerCase();
  const tagQuery = query.startsWith("#") ? query.slice(1) : "";
  const userQuery = query.startsWith("@") ? cleanUsername(query) : query;
  const users = db.users.filter((user) => user.name.toLowerCase().includes(userQuery) || user.username.includes(userQuery));
  const posts = db.posts.filter((post) => post.text.toLowerCase().includes(query) || (tagQuery && post.tags.includes(tagQuery)));
  const reels = db.reels.filter((reel) => reel.caption.toLowerCase().includes(query) || (tagQuery && extractTags(reel.caption).includes(tagQuery)));
  const tags = trendingTags().filter(([tag]) => !tagQuery || tag.includes(tagQuery));
  return `
    <div class="view-grid">
      <section class="panel">
        <div class="section-title">
          <div>
            <h2>Buscador</h2>
            <p>Usuarios, publicaciones, hashtags y reels.</p>
          </div>
        </div>
        <input id="searchInput" type="search" placeholder="Busca @usuario, #hashtag, texto o reels" value="${escapeHtml(state.search)}" />
      </section>
      ${query ? `
        <section class="panel">
          <div class="section-title"><h2>Usuarios</h2><p>${users.length} resultados</p></div>
          ${peopleCards(users.map((user) => user.id), "No hay usuarios con esa búsqueda.")}
        </section>
        <section class="view-grid">
          <div class="section-title"><h2>Publicaciones</h2><p>${posts.length} resultados</p></div>
          ${posts.map(renderPost).join("") || emptyState("No hay publicaciones relacionadas.")}
        </section>
        <section class="panel">
          <div class="section-title"><h2>Hashtags</h2><p>${tags.length} resultados</p></div>
          <div class="filter-row">${tags.map(([tag, count]) => `<button class="mini-btn" type="button" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)} · ${count}</button>`).join("") || `<span class="muted">Sin hashtags.</span>`}</div>
        </section>
        <section class="view-grid">
          <div class="section-title"><h2>Reels</h2><p>${reels.length} resultados</p></div>
          ${reels.map(renderReelCard).join("") || emptyState("No hay reels relacionados.")}
        </section>
      ` : `
        <section class="panel">
          <div class="section-title"><h2>Explorar</h2><p>Empieza por una búsqueda o toca una tendencia.</p></div>
          <div class="filter-row">${trendingTags().map(([tag, count]) => `<button class="mini-btn" type="button" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)} · ${count}</button>`).join("")}</div>
        </section>
      `}
    </div>
  `;
}

function renderSaved() {
  const me = currentUser();
  const posts = me.savedPosts.map(postById).filter(Boolean);
  const reels = me.savedReels.map(reelById).filter(Boolean);
  return `
    <div class="view-grid">
      <section class="panel">
        <div class="section-title"><h2>Favoritos</h2><p>Publicaciones y reels guardados.</p></div>
        <div class="compact-stats">
          ${statPill(posts.length, "Posts guardados")}
          ${statPill(reels.length, "Reels guardados")}
          ${statPill(posts.length + reels.length, "Total")}
        </div>
      </section>
      ${posts.map(renderPost).join("") || emptyState("Aún no guardas publicaciones.")}
      ${reels.map(renderReelCard).join("") || ""}
    </div>
  `;
}

function renderStats() {
  const user = currentUser();
  const stats = userStats(user.id);
  const progress = xpProgress(user);
  return `
    <div class="view-grid">
      <section class="panel">
        <div class="section-title">
          <div>
            <h2>Panel de actividad</h2>
            <p>Resumen de crecimiento del perfil.</p>
          </div>
        </div>
        ${activitySparkHtml()}
      </section>
      <div class="stats-grid">
        ${statCard("Publicaciones", stats.posts, "Crear contenido suma XP y acerca la verificación.")}
        ${statCard("Seguidores", stats.followers, "Crecimiento social local.")}
        ${statCard("Siguiendo", stats.following, "Perfiles que sigues.")}
        ${statCard("Amigos", stats.friends, "Conexiones aceptadas.")}
        ${statCard("Comentarios", stats.comments, "Conversaciones recibidas.")}
        ${statCard("Likes", stats.likes, "Reacciones recibidas.")}
        ${statCard("Reels", stats.reels, "Videos verticales publicados.")}
        ${statCard("Nivel", progress.level, `${user.xp} XP acumulados.`)}
      </div>
      <section class="panel">
        <div class="section-title"><h2>Logros</h2><p>${user.achievements.length} desbloqueados</p></div>
        <div class="achievement-grid">${user.achievements.map((achievement) => `<span class="badge">${escapeHtml(achievement)}</span>`).join("") || `<span class="muted">Publica, comenta y sube reels para desbloquear logros.</span>`}</div>
      </section>
    </div>
  `;
}

function statCard(title, value, detail) {
  return `<article class="stats-card"><strong>${escapeHtml(title)}</strong><h2>${value}</h2><p class="muted">${escapeHtml(detail)}</p></article>`;
}

function renderSettings() {
  const user = currentUser();
  return `
    <div class="settings-grid">
      <section class="settings-card">
        <div class="section-title">
          <div>
            <h2>Editor de perfil</h2>
            <p>Vista previa antes de guardar.</p>
          </div>
        </div>
        <form id="settingsForm" class="auth-form">
          <div class="two-fields">
            <label>Nombre<input id="settingsName" type="text" required value="${escapeHtml(user.name)}"></label>
            <label>Usuario<input id="settingsUsername" type="text" required value="${escapeHtml(user.username)}"></label>
          </div>
          <label>Biografía<textarea id="settingsBio">${escapeHtml(user.bio || "")}</textarea></label>
          <div class="two-fields">
            <label>País<input id="settingsCountry" type="text" value="${escapeHtml(user.country || "")}"></label>
            <label>Ciudad<input id="settingsCity" type="text" value="${escapeHtml(user.city || "")}"></label>
          </div>
          <label>Estado<input id="settingsStatus" type="text" value="${escapeHtml(user.status || "")}"></label>
          <div class="two-fields">
            <label>Foto<input id="settingsAvatar" type="file" accept="image/*"></label>
            <label>Banner<input id="settingsBanner" type="file" accept="image/*"></label>
          </div>
          <div class="two-fields">
            <label>Idioma<select id="settingsLanguage"><option value="es" ${user.settings.language === "es" ? "selected" : ""}>Español</option><option value="en" ${user.settings.language === "en" ? "selected" : ""}>English</option></select></label>
            <label>Tema<select id="settingsTheme"><option value="dark" selected>Oscuro</option><option value="future">Preparado futuro</option></select></label>
          </div>
          <button class="primary-btn" type="submit">Guardar cambios</button>
        </form>
        <form id="passwordForm" class="auth-form">
          <h3>Cambiar contraseña</h3>
          <div class="two-fields">
            <label>Actual<input id="oldPassword" type="password"></label>
            <label>Nueva<input id="newPassword" type="password" minlength="4"></label>
          </div>
          <button class="soft-btn" type="submit">Actualizar contraseña</button>
        </form>
      </section>
      <aside class="settings-card preview-card">
        <div class="section-title"><h2>Vista previa</h2><p>Perfil público</p></div>
        <div id="profilePreview">${profilePreviewHtml(user)}</div>
      </aside>
    </div>
  `;
}

function profilePreviewHtml(user) {
  return `
    <div class="profile-hero">
      <div class="profile-banner">${user.banner ? `<img src="${user.banner}" alt="">` : ""}</div>
      <div class="profile-body">
        <div class="profile-main">
          ${avatarHtml(user, "avatar-lg")}
          <div>
            <div class="profile-name-row"><h2>${escapeHtml(user.name)}</h2>${verifyHtml(user)}</div>
            <p class="muted">@${escapeHtml(user.username)} · ${escapeHtml(user.country || "Local")}</p>
            <p class="profile-bio">${escapeHtml(user.bio || "Tu biografía aparecerá aquí.")}</p>
            ${badgesHtml(user)}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderNotifications() {
  const list = notificationsForCurrent();
  return `
    <div class="view-grid">
      <section class="panel">
        <div class="section-title">
          <div>
            <h2>Notificaciones</h2>
            <p>Likes, comentarios, compartidos, seguidores, solicitudes y verificaciones.</p>
          </div>
          <button class="mini-btn" type="button" data-action="mark-notifications">Marcar todo</button>
        </div>
        <div class="notification-list">
          ${list.map(notificationHtml).join("") || emptyState("No hay notificaciones.")}
        </div>
      </section>
    </div>
  `;
}

function notificationsForCurrent() {
  return db.notifications.filter((item) => item.userId === currentUser().id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function unreadNotifications() {
  return notificationsForCurrent().filter((item) => !item.read);
}

function notificationHtml(item) {
  const actor = userById(item.actorId);
  return `
    <article class="notification-row ${item.read ? "" : "is-unread"}">
      ${actor ? avatarHtml(actor, "avatar-mini") : `<span class="avatar-mini">BF</span>`}
      <div class="user-lines">
        <p>${escapeHtml(item.text)}</p>
        <small>${formatDate(item.createdAt)}</small>
      </div>
    </article>
  `;
}

function markViewed(entity, type) {
  if (!entity.views.includes(currentUser().id)) {
    entity.views.push(currentUser().id);
    if (type === "post" || type === "reel") saveDatabase();
  }
}

function trendingTags() {
  const map = new Map();
  db.posts.forEach((post) => post.tags.forEach((tag) => map.set(tag, (map.get(tag) || 0) + 1)));
  db.reels.forEach((reel) => extractTags(reel.caption).forEach((tag) => map.set(tag, (map.get(tag) || 0) + 1)));
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function afterRender() {
  setupReelAutoplay();
}

function setupReelAutoplay() {
  if (reelObserver) reelObserver.disconnect();
  const videos = $$("[data-reel-video]");
  if (!videos.length) return;
  reelObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const video = entry.target;
      if (entry.isIntersecting) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    });
  }, { threshold: 0.58 });
  videos.forEach((video) => reelObserver.observe(video));
}

function setView(view) {
  state.view = view;
  if (view === "profile") {
    state.activeProfileId ||= currentUser().id;
  }
  document.body.classList.remove("menu-open");
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openModal(title, body) {
  const root = $("#modalRoot");
  root.innerHTML = `
    <div class="modal-card glass-panel">
      <div class="modal-head">
        <h3>${escapeHtml(title)}</h3>
        <button class="icon-btn" type="button" data-action="close-modal" aria-label="Cerrar">×</button>
      </div>
      <div class="modal-body">${body}</div>
    </div>
  `;
  root.classList.remove("is-hidden");
}

function closeModal() {
  $("#modalRoot").classList.add("is-hidden");
  $("#modalRoot").innerHTML = "";
}

function spawnRipple(event) {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  const rect = button.getBoundingClientRect();
  const ripple = document.createElement("span");
  ripple.className = "ripple";
  ripple.style.left = `${event.clientX - rect.left}px`;
  ripple.style.top = `${event.clientY - rect.top}px`;
  button.appendChild(ripple);
  setTimeout(() => ripple.remove(), 560);
}

document.addEventListener("click", async (event) => {
  spawnRipple(event);
  const authTab = event.target.closest("[data-auth-panel]");
  if (authTab) {
    setAuthPanel(authTab.dataset.authPanel);
    return;
  }

  const profileTarget = event.target.closest("[data-profile]");
  if (profileTarget) {
    state.activeProfileId = profileTarget.dataset.profile;
    state.profileTab = "posts";
    setView("profile");
    return;
  }

  const tagTarget = event.target.closest("[data-tag]");
  if (tagTarget) {
    state.activeTag = tagTarget.dataset.tag.toLowerCase();
    state.search = `#${state.activeTag}`;
    setView("feed");
    return;
  }

  const mentionTarget = event.target.closest("[data-mention]");
  if (mentionTarget) {
    const user = userByUsername(mentionTarget.dataset.mention);
    if (user) {
      state.activeProfileId = user.id;
      state.profileTab = "posts";
      setView("profile");
    } else {
    toast("Mención no encontrada", "Ese usuario no existe en BlackFrame.");
    }
    return;
  }

  const viewTarget = event.target.closest("[data-view]");
  if (viewTarget) {
    event.preventDefault();
    if (viewTarget.dataset.view === "profile") state.activeProfileId = currentUser()?.id;
    setView(viewTarget.dataset.view);
    return;
  }

  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) return;
  const action = actionTarget.dataset.action;
  if (action === "close-modal") closeModal();
  if (action === "logout") {
    clearSession();
    render();
    toast("Sesión cerrada");
  }
  if (action === "toggle-mobile-menu") document.body.classList.toggle("menu-open");
  if (action === "toggle-focus") {
    state.focusMode = !state.focusMode;
    render();
  }
  if (action === "exit-focus") {
    state.focusMode = false;
    render();
  }
  if (action === "insert-sample-tags") {
    const input = $("#postText");
    input.value = `${input.value} #blackframe`.trim();
    input.focus();
  }
  if (action === "clear-tag") {
    state.activeTag = "";
    render();
  }
  if (action === "load-more-feed") {
    state.feedLimit += 6;
    render();
  }
  if (action === "like-post") togglePostLike(actionTarget.dataset.postId);
  if (action === "save-post") togglePostSave(actionTarget.dataset.postId);
  if (action === "share-post") sharePost(actionTarget.dataset.postId);
  if (action === "view-likes") showPostLikes(actionTarget.dataset.postId);
  if (action === "edit-post") editPost(actionTarget.dataset.postId);
  if (action === "delete-post") await deletePost(actionTarget.dataset.postId);
  if (action === "report-post") reportPost(actionTarget.dataset.postId);
  if (action === "focus-comment") {
    const postCard = actionTarget.closest("[data-post-id]");
    postCard?.querySelector(".comment-form input")?.focus();
  }
  if (action === "vote-poll") votePoll(actionTarget.dataset.postId, Number(actionTarget.dataset.option));
  if (action === "reply-comment") replyComment(actionTarget.dataset.postId, actionTarget.dataset.commentId);
  if (action === "edit-comment") editComment(actionTarget.dataset.postId, actionTarget.dataset.commentId);
  if (action === "delete-comment") deleteComment(actionTarget.dataset.postId, actionTarget.dataset.commentId);
  if (action === "edit-reply") editReply(actionTarget.dataset.postId, actionTarget.dataset.commentId, actionTarget.dataset.replyId);
  if (action === "delete-reply") deleteReply(actionTarget.dataset.postId, actionTarget.dataset.commentId, actionTarget.dataset.replyId);
  if (action === "profile-tab") {
    state.profileTab = actionTarget.dataset.tab;
    render();
  }
  if (["follow", "unfollow", "send-friend", "cancel-friend", "accept-friend", "reject-friend", "remove-friend"].includes(action)) {
    handleSocialAction(action, actionTarget.dataset.userId);
  }
  if (action === "like-reel") toggleReelLike(actionTarget.dataset.reelId);
  if (action === "save-reel") toggleReelSave(actionTarget.dataset.reelId);
  if (action === "share-reel") shareReel(actionTarget.dataset.reelId);
  if (action === "comment-reel") commentReel(actionTarget.dataset.reelId);
  if (["pause-reel", "volume-reel", "speed-reel", "fullscreen-reel"].includes(action)) controlReel(action, actionTarget.dataset.reelId);
  if (action === "select-conversation") {
    state.selectedConversationId = actionTarget.dataset.conversationId;
    render();
  }
  if (action === "edit-message") editMessage(actionTarget.dataset.messageId);
  if (action === "delete-message") deleteMessage(actionTarget.dataset.messageId);
  if (action === "sync-now") {
    await pullDatabaseFromServer(true);
    render();
  }
  if (action === "mark-notifications") {
    notificationsForCurrent().forEach((item) => item.read = true);
    saveDatabase();
    render();
  }
});

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.id === "loginForm") await login();
  if (form.id === "registerForm") await register();
  if (form.id === "postComposer") await createPost();
  if (form.classList.contains("comment-form")) createComment(form);
  if (form.id === "reelForm") await createReel();
  if (form.id === "messageComposer") await sendMessage(form);
  if (form.id === "settingsForm") await saveSettings();
  if (form.id === "passwordForm") await changePassword();
});

document.addEventListener("input", (event) => {
  if (event.target.id === "globalSearch" || event.target.id === "searchInput") {
    state.search = event.target.value;
    if (event.target.id === "globalSearch" && state.view !== "search" && state.search.trim().length > 1) state.view = "search";
    render();
  }
  if (event.target.id === "conversationSearch") {
    state.messageSearch = event.target.value;
    render();
  }
  if (event.target.id === "messageText") {
    state.typing = event.target.value.trim().length > 0;
    const head = $(".chat-head small");
    const selected = conversationById(state.selectedConversationId);
    const other = selected ? otherParticipant(selected) : null;
    if (head) head.textContent = `@${other?.username || "usuario"} · ${state.typing ? "escribiendo..." : other?.status || "Online"}`;
  }
  if (event.target.closest("#settingsForm")) updateProfilePreview();
});

document.addEventListener("change", async (event) => {
  if (event.target.id === "postMedia") await previewMedia(event.target.files[0], $("#postPreview"));
  if (event.target.id === "settingsAvatar" || event.target.id === "settingsBanner") updateProfilePreview();
});

$("#demoLogin")?.addEventListener("click", () => {});

function setAuthPanel(panel) {
  $$(".auth-tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.authPanel === panel));
  $("#loginForm").classList.toggle("is-hidden", panel !== "login");
  $("#registerForm").classList.toggle("is-hidden", panel !== "register");
}

async function login() {
  const username = cleanUsername($("#loginUser").value);
  const password = $("#loginPassword").value;
  const user = db.users.find((item) => item.username === username);
  if (!await verifyPassword(user, password)) {
    toast("No se pudo iniciar sesión", "Revisa usuario y contraseña.");
    return;
  }
  setSession(user.id, $("#rememberSession").checked);
  toast("Sesión iniciada", `Hola, ${user.name}.`);
  render();
}

async function register() {
  const username = cleanUsername($("#registerUser").value);
  const name = $("#registerName").value.trim();
  const email = $("#registerEmail").value.trim();
  const password = $("#registerPassword").value;
  if (!name || !username || password.length < 4) {
    toast("Registro incompleto", "Nombre, usuario y contraseña son obligatorios.");
    return;
  }
  if (userByUsername(username)) {
    toast("Usuario no disponible", "Elige otro @usuario.");
    return;
  }
  const avatarFile = $("#registerAvatar").files[0];
  let avatar = "";
  try {
    avatar = avatarFile ? await uploadImageOnly(avatarFile, "avatars") : "";
  } catch (error) {
    toast("Foto no subida", error.message);
    return;
  }
  const id = uid("u");
  const user = {
    id,
    name,
    username,
    email,
    passwordHash: await hashPassword(id, password),
    avatar,
    banner: "",
    bio: "Nuevo perfil en BlackFrame.",
    country: "Local",
    city: "",
    createdAt: now(),
    status: "Online",
    followers: [],
    following: [],
    friends: [],
    requestsIn: [],
    requestsOut: [],
    savedPosts: [],
    savedReels: [],
    xp: 0,
    level: 1,
    verified: "normal",
    badges: ["⭐ Gamer"],
    achievements: [],
    settings: { language: "es", theme: "dark" }
  };
  db.users.push(user);
  pushNotification(user.id, "welcome", "Bienvenido a BlackFrame. Tu cuenta local está lista.", "system", null);
  saveDatabase();
  setSession(user.id, true);
  render();
  toast("Cuenta creada", "Tu perfil ya está activo.");
}

async function createPost() {
  const text = $("#postText").value.trim();
  const file = $("#postMedia").files[0];
  const pollQuestion = $("#pollQuestion").value.trim();
  const options = $("#pollOptions").value.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 6);
  if (!text && !file && (!pollQuestion || options.length < 2)) {
    toast("Publicación vacía", "Agrega texto, multimedia o una encuesta válida.");
    return;
  }
  let media = null;
  try {
    media = file ? await uploadMediaFile(file, "posts") : null;
  } catch (error) {
    toast("No se pudo subir", error.message);
    return;
  }
  const post = {
    id: uid("p"),
    userId: currentUser().id,
    text,
    media,
    poll: pollQuestion && options.length >= 2 ? { question: pollQuestion, options: options.map((option) => ({ text: option, votes: [] })) } : null,
    likes: [],
    comments: [],
    shares: [],
    savedBy: [],
    views: [currentUser().id],
    tags: extractTags(text),
    mentions: extractMentions(text),
    createdAt: now(),
    updatedAt: null
  };
  db.posts.unshift(post);
  notifyMentions(post.mentions, "mention", `${currentUser().name} te mencionó en una publicación.`, post.id);
  awardXP(currentUser().id, 30, "publicar");
  saveDatabase();
  state.feedLimit = Math.max(state.feedLimit, 8);
  render();
  toast("Publicado", "Tu publicación ya está en el feed.");
}

function createComment(form) {
  const post = postById(form.dataset.postId);
  const input = form.elements.comment;
  const text = input.value.trim();
  if (!post || !text) {
    toast("Comentario vacío", "Escribe algo antes de comentar.");
    return;
  }
  post.comments.push({ id: uid("c"), userId: currentUser().id, text, createdAt: now(), edited: false, replies: [] });
  if (post.userId !== currentUser().id) pushNotification(post.userId, "comment", `${currentUser().name} comentó tu publicación.`, currentUser().id, post.id);
  notifyMentions(extractMentions(text), "mention", `${currentUser().name} te mencionó en un comentario.`, post.id);
  awardXP(currentUser().id, 12, "comentar");
  saveDatabase();
  render();
}

async function createReel() {
  const file = $("#reelVideo").files[0];
  const caption = $("#reelCaption").value.trim();
  if (!file || !file.type.startsWith("video/")) {
    toast("Video requerido", "Sube un video para crear un reel.");
    return;
  }
  let media = null;
  try {
    media = await uploadMediaFile(file, "reels");
  } catch (error) {
    toast("No se pudo subir el reel", error.message);
    return;
  }
  const reel = {
    id: uid("r"),
    userId: currentUser().id,
    caption,
    media,
    likes: [],
    comments: [],
    shares: [],
    savedBy: [],
    views: [currentUser().id],
    speed: 1,
    muted: true,
    createdAt: now()
  };
  db.reels.unshift(reel);
  notifyMentions(extractMentions(caption), "mention", `${currentUser().name} te mencionó en un reel.`, reel.id);
  awardXP(currentUser().id, 45, "subir reels");
  saveDatabase();
  render();
  toast("Reel publicado", "Tu video vertical ya está disponible.");
}

async function sendMessage(form) {
  const conversation = conversationById(form.dataset.conversationId);
  const text = $("#messageText").value.trim();
  const file = $("#messageFile").files[0];
  if (!conversation || (!text && !file)) {
    toast("Mensaje vacío", "Escribe texto o adjunta un archivo.");
    return;
  }
  let media = null;
  try {
    media = file ? await uploadMediaFile(file, "messages") : null;
  } catch (error) {
    toast("Adjunto no enviado", error.message);
    return;
  }
  conversation.messages.push({
    id: uid("m"),
    senderId: currentUser().id,
    text,
    media,
    createdAt: now(),
    edited: false
  });
  const other = otherParticipant(conversation);
  if (other) pushNotification(other.id, "message", `${currentUser().name} te envió un mensaje.`, currentUser().id, conversation.id);
  state.typing = false;
  saveDatabase();
  render();
}

async function saveSettings() {
  const user = currentUser();
  const username = cleanUsername($("#settingsUsername").value);
  if (!username) {
    toast("Usuario inválido", "El @usuario no puede quedar vacío.");
    return;
  }
  const owner = userByUsername(username);
  if (owner && owner.id !== user.id) {
    toast("Usuario no disponible", "Ese @usuario ya existe.");
    return;
  }
  user.name = $("#settingsName").value.trim() || user.name;
  user.username = username;
  user.bio = $("#settingsBio").value.trim();
  user.country = $("#settingsCountry").value.trim();
  user.city = $("#settingsCity").value.trim();
  user.status = $("#settingsStatus").value.trim();
  user.settings.language = $("#settingsLanguage").value;
  user.settings.theme = $("#settingsTheme").value;
  const avatarFile = $("#settingsAvatar").files[0];
  const bannerFile = $("#settingsBanner").files[0];
  try {
    if (avatarFile) user.avatar = await uploadImageOnly(avatarFile, "avatars");
    if (bannerFile) user.banner = await uploadImageOnly(bannerFile, "banners");
  } catch (error) {
    toast("Imagen no subida", error.message);
    return;
  }
  saveDatabase();
  render();
  toast("Perfil actualizado", "Tus cambios quedaron sincronizados.");
}

async function changePassword() {
  const user = currentUser();
  const oldPassword = $("#oldPassword").value;
  const newPassword = $("#newPassword").value;
  if (!await verifyPassword(user, oldPassword)) {
    toast("Contraseña actual incorrecta");
    return;
  }
  if (newPassword.length < 4) {
    toast("Contraseña muy corta", "Usa al menos 4 caracteres en esta demo.");
    return;
  }
  user.passwordHash = await hashPassword(user.id, newPassword);
  delete user.password;
  saveDatabase();
  $("#passwordForm").reset();
  toast("Contraseña cambiada");
}

function notifyMentions(mentions, type, text, entityId) {
  mentions.forEach((username) => {
    const target = userByUsername(username);
    if (target && target.id !== currentUser().id) pushNotification(target.id, type, text, currentUser().id, entityId);
  });
}

function togglePostLike(id) {
  const post = postById(id);
  if (!post) return;
  const me = currentUser();
  const index = post.likes.indexOf(me.id);
  if (index >= 0) {
    post.likes.splice(index, 1);
  } else {
    post.likes.push(me.id);
    if (post.userId !== me.id) {
      pushNotification(post.userId, "like", `${me.name} dio like a tu publicación.`, me.id, post.id);
      awardXP(post.userId, 4, "recibir likes");
    }
  }
  saveDatabase();
  render();
}

function togglePostSave(id) {
  const me = currentUser();
  const post = postById(id);
  if (!post) return;
  toggleArray(me.savedPosts, id);
  toggleArray(post.savedBy, me.id);
  saveDatabase();
  render();
}

function sharePost(id) {
  const post = postById(id);
  if (!post) return;
  if (!post.shares.includes(currentUser().id)) post.shares.push(currentUser().id);
  if (post.userId !== currentUser().id) pushNotification(post.userId, "share", `${currentUser().name} compartió tu publicación.`, currentUser().id, post.id);
  saveDatabase();
  render();
  toast("Compartido", "Acción simulada registrada en localStorage.");
}

function showPostLikes(id) {
  const post = postById(id);
  if (!post) return;
  openModal("Personas que dieron like", post.likes.map(userById).filter(Boolean).map((user) => `
    <div class="notification-row">${avatarHtml(user, "avatar-mini")}<div class="user-lines"><strong>${escapeHtml(user.name)}</strong><small>@${escapeHtml(user.username)}</small></div></div>
  `).join("") || emptyState("Nadie ha dado like todavía."));
}

function editPost(id) {
  const post = postById(id);
  if (!post || post.userId !== currentUser().id) return;
  const text = prompt("Editar publicación", post.text);
  if (text === null) return;
  if (!text.trim() && !post.media && !post.poll) {
    toast("Publicación vacía", "No puedes dejarla vacía.");
    return;
  }
  post.text = text.trim();
  post.tags = extractTags(post.text);
  post.mentions = extractMentions(post.text);
  post.updatedAt = now();
  saveDatabase();
  render();
}

async function deletePost(id) {
  const post = postById(id);
  if (!post || post.userId !== currentUser().id) return;
  if (!confirm("¿Eliminar esta publicación? Esta acción no se puede deshacer.")) return;
  await deleteStorageMedia(post.media);
  db.posts = db.posts.filter((item) => item.id !== id);
  db.users.forEach((user) => {
    user.savedPosts = user.savedPosts.filter((savedId) => savedId !== id);
  });
  saveDatabase();
  render();
  toast("Publicación eliminada");
}

function reportPost(id) {
  const post = postById(id);
  if (!post) return;
  db.reports.push({ id: uid("report"), postId: id, reporterId: currentUser().id, createdAt: now(), status: "simulado" });
  saveDatabase();
  toast("Reporte simulado", "Quedó registrado localmente.");
}

function votePoll(postId, optionIndex) {
  const post = postById(postId);
  if (!post?.poll?.options[optionIndex]) return;
  post.poll.options.forEach((option) => {
    option.votes = option.votes.filter((id) => id !== currentUser().id);
  });
  post.poll.options[optionIndex].votes.push(currentUser().id);
  saveDatabase();
  render();
}

function replyComment(postId, commentId) {
  const post = postById(postId);
  const comment = post?.comments.find((item) => item.id === commentId);
  if (!comment) return;
  const text = prompt("Responder comentario");
  if (!text?.trim()) return;
  comment.replies ||= [];
  comment.replies.push({ id: uid("reply"), userId: currentUser().id, text: text.trim(), createdAt: now(), edited: false });
  if (post.userId !== currentUser().id) pushNotification(post.userId, "comment", `${currentUser().name} respondió un comentario.`, currentUser().id, post.id);
  awardXP(currentUser().id, 8, "responder comentarios");
  saveDatabase();
  render();
}

function editComment(postId, commentId) {
  const post = postById(postId);
  const comment = post?.comments.find((item) => item.id === commentId);
  if (!comment || comment.userId !== currentUser().id) return;
  const text = prompt("Editar comentario", comment.text);
  if (!text?.trim()) return;
  comment.text = text.trim();
  comment.edited = true;
  saveDatabase();
  render();
}

function deleteComment(postId, commentId) {
  const post = postById(postId);
  const comment = post?.comments.find((item) => item.id === commentId);
  if (!post || !comment || comment.userId !== currentUser().id) return;
  if (!confirm("¿Eliminar este comentario?")) return;
  post.comments = post.comments.filter((item) => item.id !== commentId);
  saveDatabase();
  render();
}

function editReply(postId, commentId, replyId) {
  const post = postById(postId);
  const comment = post?.comments.find((item) => item.id === commentId);
  const reply = comment?.replies?.find((item) => item.id === replyId);
  if (!reply || reply.userId !== currentUser().id) return;
  const text = prompt("Editar respuesta", reply.text);
  if (!text?.trim()) return;
  reply.text = text.trim();
  reply.edited = true;
  saveDatabase();
  render();
}

function deleteReply(postId, commentId, replyId) {
  const post = postById(postId);
  const comment = post?.comments.find((item) => item.id === commentId);
  const reply = comment?.replies?.find((item) => item.id === replyId);
  if (!comment || !reply || reply.userId !== currentUser().id) return;
  if (!confirm("¿Eliminar esta respuesta?")) return;
  comment.replies = comment.replies.filter((item) => item.id !== replyId);
  saveDatabase();
  render();
}

function handleSocialAction(action, targetId) {
  const me = currentUser();
  const target = userById(targetId);
  if (!target || target.id === me.id) return;
  if (action === "follow") {
    addUnique(me.following, target.id);
    addUnique(target.followers, me.id);
    pushNotification(target.id, "follow", `${me.name} empezó a seguirte.`, me.id, null);
    awardXP(target.id, 15, "conseguir seguidores");
  }
  if (action === "unfollow") {
    removeItem(me.following, target.id);
    removeItem(target.followers, me.id);
  }
  if (action === "send-friend") {
    addUnique(me.requestsOut, target.id);
    addUnique(target.requestsIn, me.id);
    pushNotification(target.id, "friend", `${me.name} te envió una solicitud de amistad.`, me.id, null);
  }
  if (action === "cancel-friend") {
    removeItem(me.requestsOut, target.id);
    removeItem(target.requestsIn, me.id);
  }
  if (action === "accept-friend") {
    addUnique(me.friends, target.id);
    addUnique(target.friends, me.id);
    removeItem(me.requestsIn, target.id);
    removeItem(target.requestsOut, me.id);
    pushNotification(target.id, "friend", `${me.name} aceptó tu solicitud de amistad.`, me.id, null);
  }
  if (action === "reject-friend") {
    removeItem(me.requestsIn, target.id);
    removeItem(target.requestsOut, me.id);
  }
  if (action === "remove-friend") {
    removeItem(me.friends, target.id);
    removeItem(target.friends, me.id);
  }
  saveDatabase();
  render();
}

function toggleReelLike(id) {
  const reel = reelById(id);
  if (!reel) return;
  const me = currentUser();
  const index = reel.likes.indexOf(me.id);
  if (index >= 0) {
    reel.likes.splice(index, 1);
  } else {
    reel.likes.push(me.id);
    if (reel.userId !== me.id) {
      pushNotification(reel.userId, "like", `${me.name} dio like a tu reel.`, me.id, reel.id);
      awardXP(reel.userId, 4, "recibir likes");
    }
  }
  saveDatabase();
  render();
}

function toggleReelSave(id) {
  const reel = reelById(id);
  if (!reel) return;
  toggleArray(currentUser().savedReels, id);
  toggleArray(reel.savedBy, currentUser().id);
  saveDatabase();
  render();
}

function shareReel(id) {
  const reel = reelById(id);
  if (!reel) return;
  addUnique(reel.shares, currentUser().id);
  if (reel.userId !== currentUser().id) pushNotification(reel.userId, "share", `${currentUser().name} compartió tu reel.`, currentUser().id, reel.id);
  saveDatabase();
  render();
  toast("Reel compartido", "Acción simulada registrada.");
}

function commentReel(id) {
  const reel = reelById(id);
  if (!reel) return;
  const text = prompt("Comentar reel");
  if (!text?.trim()) return;
  reel.comments.push({ id: uid("rc"), userId: currentUser().id, text: text.trim(), createdAt: now(), edited: false });
  if (reel.userId !== currentUser().id) pushNotification(reel.userId, "comment", `${currentUser().name} comentó tu reel.`, currentUser().id, reel.id);
  awardXP(currentUser().id, 12, "comentar reels");
  saveDatabase();
  render();
}

function controlReel(action, id) {
  const reel = reelById(id);
  const card = $(`[data-reel-id="${id}"]`);
  const video = card?.querySelector("video");
  if (action === "fullscreen-reel") {
    card?.querySelector(".reel-stage")?.requestFullscreen?.();
    return;
  }
  if (!reel || !video) {
    toast("Control simulado", "Sube un video real para usar este control.");
    return;
  }
  if (action === "pause-reel") {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }
  if (action === "volume-reel") {
    video.muted = !video.muted;
    reel.muted = video.muted;
  }
  if (action === "speed-reel") {
    const speeds = [0.75, 1, 1.25, 1.5, 2];
    const next = speeds[(speeds.indexOf(reel.speed || 1) + 1) % speeds.length];
    reel.speed = next;
    video.playbackRate = next;
  }
  saveDatabase();
  render();
}

function editMessage(messageId) {
  const conversation = conversationById(state.selectedConversationId);
  const message = conversation?.messages.find((item) => item.id === messageId);
  if (!message || message.senderId !== currentUser().id) return;
  const text = prompt("Editar mensaje", message.text);
  if (text === null) return;
  message.text = text.trim();
  message.edited = true;
  saveDatabase();
  render();
}

function deleteMessage(messageId) {
  const conversation = conversationById(state.selectedConversationId);
  const message = conversation?.messages.find((item) => item.id === messageId);
  if (!conversation || !message || message.senderId !== currentUser().id) return;
  if (!confirm("¿Eliminar este mensaje?")) return;
  conversation.messages = conversation.messages.filter((item) => item.id !== messageId);
  saveDatabase();
  render();
}

async function previewMedia(file, target) {
  if (!file || !target) return;
  const type = detectMediaType(file);
  const data = await readFileAsDataUrl(file);
  target.classList.remove("is-hidden");
  target.innerHTML = type === "video"
    ? `<video src="${data}" controls playsinline></video>`
    : `<img src="${data}" alt="${escapeHtml(file.name)}">`;
}

async function updateProfilePreview() {
  const user = { ...currentUser() };
  user.name = $("#settingsName")?.value || user.name;
  user.username = cleanUsername($("#settingsUsername")?.value || user.username);
  user.bio = $("#settingsBio")?.value || "";
  user.country = $("#settingsCountry")?.value || "";
  const avatarFile = $("#settingsAvatar")?.files?.[0];
  const bannerFile = $("#settingsBanner")?.files?.[0];
  if (avatarFile) user.avatar = await readFileAsDataUrl(avatarFile);
  if (bannerFile) user.banner = await readFileAsDataUrl(bannerFile);
  const preview = $("#profilePreview");
  if (preview) preview.innerHTML = profilePreviewHtml(user);
}

function toggleArray(array, value) {
  const index = array.indexOf(value);
  if (index >= 0) array.splice(index, 1);
  else array.push(value);
}

function addUnique(array, value) {
  if (!array.includes(value)) array.push(value);
}

function removeItem(array, value) {
  const index = array.indexOf(value);
  if (index >= 0) array.splice(index, 1);
}

async function init() {
  await loadDatabase();
  const sessionUser = getSession();
  if (sessionUser && userById(sessionUser)) state.currentUserId = sessionUser;
  setTimeout(() => {
    $("#loadingScreen").classList.add("is-done");
    render();
  }, 520);
}

init();
