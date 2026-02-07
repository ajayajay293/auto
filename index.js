const { Telegraf, Markup, session } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const QRCode = require('qrcode'); // npm i qrcode
const getDb = () => loadDb();
const config = require('./config');

const bot = new Telegraf(config.BOT_TOKEN);
bot.use(session());

// --- KONFIGURASI GAMBAR (Ganti URL dengan link foto Anda) ---
const IMG_MAIN = 'https://foto-to-url.gt.tc/uploads/img_697f4b7c58fa58.07948102.jpg'; 
const IMG_SERVICES = 'https://foto-to-url.gt.tc/uploads/img_697f4b7c58fa58.07948102.jpg';

// --- DATABASE JSON ---
const DB_FILE = './database.json';
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, pending_depo: {} }));
}

const loadDb = () => {
    try {
        if (!fs.existsSync(DB_FILE)) {
            const initialData = { users: {}, pending_depo: {} };
            fs.writeFileSync(DB_FILE, JSON.stringify(initialData));
            return initialData;
        }
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        console.error("Gagal baca DB:", e);
        return { users: {}, pending_depo: {} };
    }
};

const saveDb = (data) => fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

const escapeMarkdown = (text) => {
    return text.toString().replace(/(\.|\-|\!|\_|\*|\[|\]|\(|\)|\~|\`|\>|\#|\+|\=|\||\{|\}|\!)/g, '\\$1');
};

const initUser = (ctx, refId = null) => {
    const db = loadDb();
    const userId = ctx.from.id.toString();

    if (!db.users[userId]) {
        // Logika Referral: Jangan izinkan mengundang diri sendiri
        const finalReferrer = (refId && refId !== userId && db.users[refId]) ? refId : null;

        db.users[userId] = {
            username: ctx.from.username || 'User',
            saldo: 0,
            history: [],
            deposits: [],
            invitedBy: finalReferrer,
            referralsCount: 0,
            hasDeposited: false
        };

        if (finalReferrer) {
            db.users[finalReferrer].referralsCount += 1;
            // Kirim notif ke pengundang bahwa ada yang bergabung
            ctx.telegram.sendMessage(finalReferrer, `👥 *Undangan Baru!*\n\n${ctx.from.first_name} bergabung menggunakan link Anda. Saldo bonus akan cair setelah dia deposit min Rp1.000.`, { parse_mode: 'Markdown' }).catch(() => {});
        }
        
        saveDb(db);
    }
    return db.users[userId];
};

const callApi = async (path, params = {}) => {
    try {
        const response = await axios.post(`${config.BASE_URL}${path}`, {
            api_id: config.API_ID,
            api_key: config.API_KEY,
            ...params
        }, { timeout: 5000 }); // Tambahkan timeout 5 detik
        return response.data;
    } catch (e) {
        console.error("API Error:", e.message);
        return { status: false, msg: "Server SMM sedang sibuk." };
    }
};

const checkSub = async (ctx) => {
    const userId = ctx.from.id;
    for (const channel of config.channels) {
        try {
            const member = await ctx.telegram.getChatMember(channel, userId);
            const status = ['member', 'administrator', 'creator'].includes(member.status);
            if (!status) return false;
        } catch (e) {
            console.error(`Error checking sub for ${channel}:`, e.message);
            return false; // Anggap belum join jika error/bot bukan admin
        }
    }
    return true;
};

const checkSubscriptionFlow = async (ctx, next) => {
    const isSubscribed = await checkSub(ctx);
    
    if (!isSubscribed) {
        const buttons = config.channels.map((ch, i) => [
            Markup.button.url(`📢 Channel ${i + 1}`, `https://t.me/${ch.replace('@', '')}`)
        ]);
        buttons.push([Markup.button.callback('✅ SAYA SUDAH JOIN', 'back_to_start')]);

        return ctx.replyWithPhoto(IMG_MAIN, {
            caption: "⚠️ **AKSES DITOLAK**\n\nUntuk menggunakan bot ini, Anda wajib bergabung di channel kami terlebih dahulu.",
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons)
        });
    }
    return next();
};

// Pasang middleware di perintah utama
bot.start(async (ctx) => {
    // Ambil ID pengundang dari payload start
    const payload = ctx.startPayload; // Isinya 'ref_12345'
    let referrerId = null;
    if (payload && payload.startsWith('ref_')) {
        referrerId = payload.replace('ref_', '');
    }

    // Inisialisasi user dengan membawa ID pengundang
    initUser(ctx, referrerId);

    // Lanjutkan ke pengecekan sub dan menu utama
    await checkSubscriptionFlow(ctx, () => mainMenu(ctx));
});

// Update juga action back_to_start agar mengecek ulang
bot.action('back_to_start', async (ctx) => {
    await checkSubscriptionFlow(ctx, () => mainMenu(ctx));
});

// --- MENU UTAMA ---
const mainMenu = async (ctx) => {
    const user = initUser(ctx);

    const text = `
───〔 🌟 FAYUPEDIA PREMIUM 〕───

👤 PENGGUNA: ${ctx.from.first_name}
💰 SALDO: Rp${user.saldo.toLocaleString('id-ID')}
📊 PESANAN: ${user.history.length} Transaksi

✨ PLATFORM OPTIMASI SOSIAL MEDIA
Proses Instant, Aman, & Bergaransi 24/7

⚠️ PENTING:
• Gunakan akun PUBLIC (Jangan Private)
• Input Target dengan benar (No Refund)
• Dilarang order ganda di target yang sama

🚀 Pilihlah menu di bawah untuk memulai:
`;

    const buttons = [
        [Markup.button.callback('🛒 Layanan', 'services_0'), Markup.button.callback('💳 Deposit', 'menu_depo')],
        [Markup.button.callback('👤 Profil', 'user_profile'), Markup.button.callback('📜 Riwayat', 'history')]
    ];

    if (ctx.from.id == config.ownerId) {
        buttons.push([Markup.button.callback('⚙️ PANEL ADMIN', 'admin_panel')]);
    }
    buttons.push([Markup.button.url('👨‍💻 Owner', 'https://t.me/JarrGanteng')]);

    // --- LOGIKA PENGHAPUSAN ---
    // Jika masuk ke sini karena klik TOMBOL (Callback), hapus pesan bot yang lama.
    // Jika masuk ke sini karena ketik /start (Message), biarkan saja.
    if (ctx.updateType === 'callback_query') {
        await ctx.deleteMessage().catch(() => {});
    }

    return ctx.replyWithPhoto(IMG_MAIN, { 
        caption: text, 
        parse_mode: 'Markdown', 
        ...Markup.inlineKeyboard(buttons) 
    });
};

bot.start((ctx) => mainMenu(ctx));

// --- DAFTAR LAYANAN ---
bot.action(/services_(\d+)/, async (ctx) => {
    const page = parseInt(ctx.match[1]);
    const res = await callApi('/services');
    if (!res.status) return ctx.answerCbQuery(res.msg);

    const categories = [...new Set(res.services.map(s => s.category))];
    const perPage = 8;
    const paginated = categories.slice(page * perPage, (page + 1) * perPage);

    const buttons = paginated.map(cat => [Markup.button.callback(cat, `cat_${categories.indexOf(cat)}_0`)]);
    const nav = [];
    if (page > 0) nav.push(Markup.button.callback('⬅️ PREV', `services_${page - 1}`));
    if ((page + 1) * perPage < categories.length) nav.push(Markup.button.callback('NEXT ➡️', `services_${page + 1}`));
    if (nav.length > 0) buttons.push(nav);
    buttons.push([Markup.button.callback('🏠 MENU UTAMA', 'back_to_start')]);

    await ctx.deleteMessage().catch(() => {});
    ctx.replyWithPhoto(IMG_SERVICES, { 
        caption: "`📂 SILAHKAN PILIH KATEGORI LAYANAN:`", 
        parse_mode: 'MarkdownV2', 
        ...Markup.inlineKeyboard(buttons) 
    });
});

// --- ACTION CEK STATUS RUMAH OTP ---
bot.action(/^cek_atlantic_(.+)/, async (ctx) => {
    const depoId = ctx.match[1];
    const CHANNEL_ID = '-1003648588091';

    try {
        const formData = new URLSearchParams();
        formData.append('api_key', config.atlanticApiKey);
        formData.append('id', depoId);

        // --- CEK STATUS DEPOSIT ---
        let response = await axios.post('https://atlantich2h.com/deposit/status', formData.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        let res = response.data;
        if (!res.status) return ctx.answerCbQuery("❌ Gagal cek status.");

        let d = res.data;

        // --- JIKA MASIH PROCESSING, TRIGGER INSTANT ---
        if (d.status === 'processing' || d.status === 'pending') {
            const instantForm = new URLSearchParams();
            instantForm.append('api_key', config.atlanticApiKey);
            instantForm.append('id', depoId);
            instantForm.append('action', 'true');

            const instantRes = await axios.post('https://atlantich2h.com/deposit/instant', instantForm.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });

            if (!instantRes.data.status) 
                return ctx.answerCbQuery("⚠️ Gagal proses deposit instant.");

            d = instantRes.data.data; // update data dengan hasil instant
        }

        // --- CEK STATUS FINAL ---
        if (d.status === 'success' || d.status === 'completed') {
            const db = loadDb();
            const info = db.pending_depo[depoId];
            if (!info) return ctx.answerCbQuery("⚠️ Data sudah diproses.");

            // Tambah saldo user
            db.users[info.userId].saldo += parseInt(d.get_balance);

            // Simpan riwayat
            db.users[info.userId].deposits.unshift({
                id: depoId,
                amount: parseInt(d.get_balance),
                date: new Date().toLocaleString('id-ID')
            });

            delete db.pending_depo[depoId];
            saveDb(db);

            await ctx.deleteMessage().catch(() => {});

            // Notif User
            await ctx.reply(`<b>✅ DEPOSIT BERHASIL!</b>
━━━━━━━━━━━━━━━
💰 <b>Saldo Masuk:</b> Rp${parseInt(d.get_balance).toLocaleString()}
🆔 <b>ID:</b> <code>${depoId}</code>
━━━━━━━━━━━━━━━`, { parse_mode: "HTML" });

            // Notif Channel
            const channelText = `<b>💳 TOP UP SUCCESS</b>
━━━━━━━━━━━━━━━
👤 <b>Customer:</b> ${info.username}
💰 <b>Total Bayar:</b> Rp${parseInt(d.nominal) + parseInt(d.fee)}
📥 <b>Saldo Masuk:</b> Rp${parseInt(d.get_balance)}
🚀 <b>Status:</b> Success (Auto)
━━━━━━━━━━━━━━━`;

            ctx.telegram.sendMessage(CHANNEL_ID, channelText, { parse_mode: "HTML" });

        } else {
            return ctx.answerCbQuery("🔔 Pembayaran belum selesai, silakan cek lagi nanti.", { show_alert: true });
        }

    } catch (e) {
        console.error(e);
        return ctx.answerCbQuery("⚠️ Gagal cek status deposit.");
    }
});

// --- ACTION CANCEL RUMAH OTP ---
bot.action(/^cancel_atlantic_(.+)/, async (ctx) => {
    const depoId = ctx.match[1];

    try {
        // --- CANCEL VIA ATLANTIC ---
        const formData = new URLSearchParams();
        formData.append('api_key', config.atlanticApiKey);
        formData.append('id', depoId);

        const response = await axios.post(
            'https://atlantich2h.com/deposit/cancel',
            formData.toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const res = response.data;
        if (!res.status) {
            return ctx.answerCbQuery("⚠️ Gagal membatalkan deposit.");
        }

        // --- HAPUS DARI DB ---
        const db = loadDb();
        if (db.pending_depo[depoId]) {
            delete db.pending_depo[depoId];
            saveDb(db);
        }

        await ctx.answerCbQuery("❌ Deposit berhasil dibatalkan.");
        await ctx.deleteMessage().catch(() => {});
        return mainMenu(ctx);

    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery("⚠️ Gagal membatalkan deposit di server.");
    }
});

// --- MENU PANEL ADMIN ---
bot.action('admin_panel', async (ctx) => {
    if (ctx.from.id != config.ownerId) return ctx.answerCbQuery("Akses Ditolak!");
    
    const db = loadDb();
    const totalUser = Object.keys(db.users).length;
    
    const text = `
⚙️ *PANEL KENDALI ADMIN*
━━━━━━━━━━━━━━━
📊 *Statistik:*
• Total Pengguna: ${totalUser} User
• Status Sistem: Normal

Pilih tindakan di bawah ini:`;

    const buttons = [
        [Markup.button.callback('📢 Broadcast', 'adm_bc'), Markup.button.callback('💰 Kelola Saldo', 'adm_saldo')],
        [Markup.button.callback('🔍 Cek User', 'adm_cek_user'), Markup.button.callback('🏠 Utama', 'back_to_start')]
    ];

    await ctx.editMessageCaption(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons)
    });
});

// --- SUB MENU BROADCAST ---
bot.action('adm_bc', (ctx) => {
    ctx.session = { step: 'adm_wait_bc' };
    ctx.reply("📢 *Kirimkan pesan broadcast Anda.*\n\nBisa berupa *Teks, Foto, atau Dokumen*. Bot akan meneruskan ke seluruh user.", { parse_mode: 'Markdown' });
});

// --- SUB MENU SALDO ---
bot.action('adm_saldo', (ctx) => {
    const buttons = [
        [Markup.button.callback('➕ TAMBAH SALDO', 'adm_add_saldo')],
        [Markup.button.callback('➖ KURANGI SALDO', 'adm_min_saldo')],
        [Markup.button.callback('🔙 KEMBALI', 'admin_panel')]
    ];
    ctx.editMessageCaption("💡 *PILIH TINDAKAN SALDO:*", { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action('adm_add_saldo', (ctx) => {
    ctx.session = { step: 'wait_add_saldo' };
    ctx.reply("📝 *FORMAT TAMBAH SALDO:*\n\n`IDUSER|JUMLAH`\nContoh: `7810623034|5000`", { parse_mode: 'Markdown' });
});

bot.action('adm_min_saldo', (ctx) => {
    ctx.session = { step: 'wait_min_saldo' };
    ctx.reply("📝 *FORMAT KURANG SALDO:*\n\n`IDUSER|JUMLAH`\nContoh: `7810623034|2000`", { parse_mode: 'Markdown' });
});

bot.action('adm_cek_user', (ctx) => {
    ctx.session = { step: 'wait_cek_user' };
    ctx.reply("🔍 *MASUKKAN ID USER:*", { parse_mode: 'Markdown' });
});

bot.action(/hist_depo_(\d+)/, async (ctx) => {
    const page = parseInt(ctx.match[1]);
    const user = initUser(ctx);
    const deposits = user.deposits || [];

    if (deposits.length === 0) return ctx.answerCbQuery("Belum ada riwayat deposit.", { show_alert: true });

    let text = "<b>💳 RIWAYAT DEPOSIT TERAKHIR</b>\n\n";
    const perPage = 5;
    const paginated = deposits.slice(page * perPage, (page + 1) * perPage);

    paginated.forEach(d => {
        text += `✅ <b>Rp${d.amount.toLocaleString()}</b>\n└ ID: <code>${d.id}</code> | ${d.date}\n\n`;
    });

    const nav = [];
    if (page > 0) nav.push(Markup.button.callback('⬅️', `hist_depo_${page - 1}`));
    if ((page + 1) * perPage < deposits.length) nav.push(Markup.button.callback('➡️', `hist_depo_${page + 1}`));

    const buttons = nav.length > 0 ? [nav] : [];
    buttons.push([Markup.button.callback('🔙 KEMBALI', 'history')]);

    await ctx.editMessageCaption(text, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard(buttons)
    });
});

bot.action(/detail_order_(\d+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const user = initUser(ctx);
    const localData = user.history.find(h => h.id == orderId);
    
    await ctx.answerCbQuery("⏳ Memuat status...");
    const res = await callApi('/status', { id: orderId });

    let statusText = res.status ? res.order_status.toUpperCase() : "TIDAK DITEMUKAN";
    let remains = res.status ? res.remains : "0";

    const text = `
<b>📊 DETAIL PESANAN #${orderId}</b>
━━━━━━━━━━━━━━━
📦 <b>Layanan:</b> ${localData?.service || 'N/A'}
🎯 <b>Target:</b> <code>${localData?.target || '-'}</code>
🔢 <b>Jumlah:</b> ${localData?.qty || 0}
💰 <b>Biaya:</b> Rp${localData?.price?.toLocaleString('id-ID')}
📅 <b>Waktu:</b> ${localData?.date || '-'}

<b>STATUS TERBARU:</b>
📝 <b>Status:</b> <code>${statusText}</code>
⏳ <b>Sisa:</b> ${remains}
━━━━━━━━━━━━━━━`;

    await ctx.editMessageCaption(text, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 REFRESH', `detail_order_${orderId}`)],
            [Markup.button.callback('🔙 KEMBALI', 'hist_order_0')]
        ])
    });
});

bot.action(/hist_order_(\d+)/, async (ctx) => {
    const page = parseInt(ctx.match[1]);
    const user = initUser(ctx);
    const history = user.history || [];

    if (history.length === 0) return ctx.answerCbQuery("Belum ada riwayat pesanan.", { show_alert: true });

    const perPage = 5;
    const paginated = history.slice(page * perPage, (page + 1) * perPage);
    
    const buttons = paginated.map(item => [Markup.button.callback(`Order #${item.id}`, `detail_order_${item.id}`)]);
    
    const nav = [];
    if (page > 0) nav.push(Markup.button.callback('⬅️', `hist_order_${page - 1}`));
    if ((page + 1) * perPage < history.length) nav.push(Markup.button.callback('➡️', `hist_order_${page + 1}`));
    if (nav.length > 0) buttons.push(nav);
    buttons.push([Markup.button.callback('🔙 KEMBALI', 'history')]);

    await ctx.editMessageCaption("<b>🛒 DAFTAR PESANAN ANDA</b>\nKlik pada ID untuk melihat detail status:", {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard(buttons)
    });
});

bot.action('user_profile', async (ctx) => {
    const user = initUser(ctx);
    const botUser = ctx.botInfo.username;
    const refLink = `https://t.me/${botUser}?start=ref_${ctx.from.id}`;
    
    // Gunakan pengaman || 0 agar tidak tampil null/undefined
    const count = user.referralsCount || 0;

    const text = `
👤 *PROFIL PENGGUNA*
━━━━━━━━━━━━━━━
🆔 *ID:* \`${ctx.from.id}\`
👤 *User:* @${ctx.from.username || '-'}
💰 *Saldo:* Rp${user.saldo.toLocaleString('id-ID')}
👥 *Undangan:* ${count} Orang

🔗 *LINK REFERRAL:*
\`${refLink}\`

_Dapatkan Rp200 setiap orang yang Anda undang melakukan deposit minimal Rp1.000!_`;

    await ctx.editMessageCaption(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔙 KEMBALI', 'back_to_start')]])
    });
});

bot.action(/cat_(\d+)_(\d+)/, async (ctx) => {
    const catIndex = parseInt(ctx.match[1]);
    const page = parseInt(ctx.match[2]);
    const res = await callApi('/services');
    
    if (!res.status) return ctx.answerCbQuery("Gagal memuat layanan");

    const categories = [...new Set(res.services.map(s => s.category))];
    const targetCategory = categories[catIndex];
    const filtered = res.services.filter(s => s.category === targetCategory);
    
    const perPage = 6; // Ditingkatkan ke 6 agar pas dengan layout 2 kolom (3 baris)
    const paginated = filtered.slice(page * perPage, (page + 1) * perPage);

    let text = `📦 *KATEGORI:* ${targetCategory}\n\n`;
    
    // Fungsi Hitung Untung (Markup)
    const calculatePrice = (originalPrice) => {
        const p = parseFloat(originalPrice);
        if (p <= 5000) return p + 100;
        if (p >= 10000 && p <= 100000) return p + 2000;
        return p + 500; // Default untung untuk range lainnya
    };

    // --- LOGIKA TOMBOL 2 KOLOM ---
    const serviceButtons = [];
    for (let i = 0; i < paginated.length; i += 2) {
        const row = [];
        // Tombol Kolom 1
        const s1 = paginated[i];
        const p1 = calculatePrice(s1.price);
        text += `🆔 \`${s1.id}\` - Rp${p1.toLocaleString('id-ID')}\n🌟 ${s1.name}\n\n`;
        row.push(Markup.button.callback(`🆔 ${s1.id}`, `order_${s1.id}`));

        // Tombol Kolom 2 (Jika ada)
        if (paginated[i + 1]) {
            const s2 = paginated[i + 1];
            const p2 = calculatePrice(s2.price);
            text += `🆔 \`${s2.id}\` - Rp${p2.toLocaleString('id-ID')}\n🌟 ${s2.name}\n\n`;
            row.push(Markup.button.callback(`🆔 ${s2.id}`, `order_${s2.id}`));
        }
        serviceButtons.push(row);
    }

    const navButtons = [];
    if (page > 0) navButtons.push(Markup.button.callback('⬅️ PREV', `cat_${catIndex}_${page - 1}`));
    if ((page + 1) * perPage < filtered.length) navButtons.push(Markup.button.callback('NEXT ➡️', `cat_${catIndex}_${page + 1}`));

    const finalKeyboard = [
        ...serviceButtons,
        navButtons, // Baris Navigasi (Prev/Next)
        [Markup.button.callback('🔙 KEMBALI KE KATEGORI', 'services_0')]
    ];

    await ctx.deleteMessage().catch(() => {});
    return ctx.replyWithPhoto(IMG_SERVICES, { 
        caption: text, 
        parse_mode: 'Markdown', 
        ...Markup.inlineKeyboard(finalKeyboard) 
    });
});

// --- FLOW ORDER & BATAL ---
bot.action(/order_(\d+)/, (ctx) => {
    ctx.session = { step: 'waiting_link', serviceId: ctx.match[1] };
    ctx.reply("`🔗 MASUKKAN LINK / TARGET` \nKirimkan link target Anda sekarang atau klik batal:", { 
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ BATALKAN ORDER', 'back_to_start')]])
    });
});

// --- ACTIONS & RIWAYAT ---
bot.action('history', async (ctx) => {
    await ctx.deleteMessage().catch(() => {});
    ctx.replyWithPhoto(IMG_SERVICES, {
        caption: "<b>📜 MENU RIWAYAT</b>\nSilakan pilih jenis riwayat yang ingin dilihat:",
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🛒 RIWAYAT PESANAN', 'hist_order_0')],
            [Markup.button.callback('💳 RIWAYAT DEPOSIT', 'hist_depo_0')],
            [Markup.button.callback('🏠 MENU UTAMA', 'back_to_start')]
        ])
    });
});

bot.on('message', async (ctx) => {
    const state = ctx.session;
    if (!state) return;

    const isAdmin = ctx.from.id == config.ownerId;
    const text = ctx.message.text || "";

    // =======================================================
    // 1. LOGIKA ADMIN (Hanya jalan jika step admin aktif)
    // =======================================================
    if (isAdmin) {
        // --- BROADCAST ---
        if (state.step === 'adm_wait_bc') {
            const db = loadDb();
            const users = Object.keys(db.users);
            let success = 0;
            ctx.reply(`🚀 Memulai Broadcast ke ${users.length} user...`);
            for (const userId of users) {
                try {
                    await ctx.copyMessage(userId);
                    success++;
                } catch (e) {}
            }
            ctx.session = null;
            return ctx.reply(`✅ Broadcast Selesai!\nBerhasil terkirim ke ${success} user.`);
        }

        // --- TAMBAH SALDO ---
        if (state.step === 'wait_add_saldo') {
            if (!text.includes('|')) return ctx.reply("❌ Format salah! Gunakan ID|JUMLAH");
            const [targetId, amount] = text.split('|');
            const db = loadDb();
            if (!db.users[targetId]) return ctx.reply("❌ ID User tidak ditemukan.");
            db.users[targetId].saldo += parseInt(amount);
            saveDb(db);
            ctx.session = null;
            ctx.telegram.sendMessage(targetId, `✅ *SALDO MASUK!*\nAdmin menambahkan saldo sebesar Rp${parseInt(amount).toLocaleString()}`, { parse_mode: 'Markdown' }).catch(()=>{});
            return ctx.reply("✅ Berhasil menambahkan saldo.");
        }

        // --- KURANG SALDO ---
        if (state.step === 'wait_min_saldo') {
            if (!text.includes('|')) return ctx.reply("❌ Format salah! Gunakan ID|JUMLAH");
            const [targetId, amount] = text.split('|');
            const db = loadDb();
            if (!db.users[targetId]) return ctx.reply("❌ ID User tidak ditemukan.");
            db.users[targetId].saldo -= parseInt(amount);
            saveDb(db);
            ctx.session = null;
            return ctx.reply("✅ Berhasil mengurangi saldo.");
        }

        // --- CEK USER ---
        if (state.step === 'wait_cek_user') {
            const db = loadDb();
            const u = db.users[text];
            if (!u) return ctx.reply("❌ User tidak ditemukan.");
            ctx.session = null;
            return ctx.reply(`👤 *DATA USER ${text}*\n━━━━━━━━━━━━━━━\n• Username: @${u.username}\n• Saldo: Rp${u.saldo.toLocaleString()}\n• Total Order: ${u.history.length}\n• Total Ref: ${u.referralsCount}`, { parse_mode: 'Markdown' });
        }
    }

    // =======================================================
    // 2. LOGIKA USER (Deposit, Order, dll)
    // =======================================================
    if (!ctx.message.text) return;

if (state.step === 'wait_depo') {
    const nominal = parseInt(text);
    if (isNaN(nominal) || nominal < 1000) {
        return ctx.reply("<b>❌ NOMINAL SALAH</b>\nMinimal deposit Rp1.000", { parse_mode: "HTML" });
    }

    try {
        // --- GENERATE DEPOSIT VIA ATLANTIC ---
        const formData = new URLSearchParams();
        formData.append('api_key', config.atlanticApiKey);
        formData.append('reff_id', `dep_${Date.now()}_${ctx.from.id}`); // unique reff_id
        formData.append('nominal', nominal);
        formData.append('type', 'ewallet'); // tipe transaksi
        formData.append('metode', 'qris');

        const response = await axios.post('https://atlantich2h.com/deposit/create', formData.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const res = response.data;
        if (!res.status) return ctx.reply(`❌ Gagal: ${res.message || "Unknown error"}`);

        const d = res.data;
        const depositId = d.id;
        const totalBayar = d.nominal + d.fee; // nominal + fee
        const saldoDiterima = d.get_balance;

        // --- SIMPAN KE DB ---
        const db = loadDb();
        db.pending_depo[depositId] = {
            userId: ctx.from.id.toString(),
            amount: totalBayar,
            get_balance: saldoDiterima,
            username: ctx.from.first_name,
            qr_url: d.qr_image // simpan link QR Atlantic
        };
        saveDb(db);

        // --- AMBIL / GENERATE QR IMAGE ---
        // Ganti bagian pengambilan QR Buffer dengan ini:
// --- AMBIL / GENERATE QR IMAGE DARI QR_STRING ---
let qrBuffer;
try {
    if (d.qr_string) {
        // Generate foto QR secara lokal dari string yang diberikan API
        qrBuffer = await QRCode.toBuffer(d.qr_string, { 
            type: 'png',
            margin: 2,
            width: 300,
            color: {
                dark: '#000000',
                light: '#ffffff'
            }
        });
        console.log("✅ QR Berhasil di-generate dari qr_string");
    } else {
        // Fallback jika qr_string tidak ada (opsional)
        return ctx.reply("❌ Data QR String tidak ditemukan dari provider.");
    }
} catch (error) {
    console.error("Gagal generate QR Code:", error.message);
    return ctx.reply("❌ Gagal membuat gambar pembayaran. Silakan hubungi Admin.");
}

// --- KIRIM DETAIL PEMBAYARAN KE USER ---
await ctx.replyWithPhoto({ source: qrBuffer }, {
    caption: `<b>🧾 DETAIL PEMBAYARAN QRIS</b>
━━━━━━━━━━━━━━━
🆔 <b>ID Deposit:</b> <code>${depositId}</code>
💰 <b>Total Bayar:</b> Rp${totalBayar.toLocaleString()}
📥 <b>Saldo Diterima:</b> Rp${saldoDiterima.toLocaleString()}
⏰ <b>Expired:</b> ${new Date(d.expired_at).toLocaleTimeString()} 
━━━━━━━━━━━━━━━
<i>Scan QRIS di atas. Setelah membayar, klik tombol "CEK STATUS".</i>`,
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
        [Markup.button.callback("🔄 CEK STATUS", `cek_atlantic_${depositId}`)],
        [Markup.button.callback("❌ BATALKAN", `cancel_atlantic_${depositId}`)]
    ])
});

        ctx.session = null;

    } catch (e) {
        console.error(e);
        return ctx.reply("❌ Server deposit Atlantic sedang gangguan.");
    }
}

    // --- INPUT LINK ORDER ---
    else if (state.step === 'waiting_link') {
        ctx.session.link = text;
        ctx.session.step = 'waiting_quantity';
        return ctx.reply('`🔢 MASUKKAN JUMLAH PESANAN:`', { 
            parse_mode: 'MarkdownV2',
            ...Markup.inlineKeyboard([[Markup.button.callback('❌ BATALKAN', 'back_to_start')]])
        });
    }

    // --- INPUT JUMLAH ORDER ---
    else if (state.step === 'waiting_quantity') {
        const qty = parseInt(text);
        if (isNaN(qty) || qty <= 0) return ctx.reply("❌ Masukkan angka valid!");

        const db = getDb();
        const res = await callApi('/services');
        const service = res.services.find(s => s.id == state.serviceId);
        if (!service) return ctx.reply("❌ Layanan tidak ditemukan.");

        const calculatePrice = (op) => {
            const p = parseFloat(op);
            return p <= 5000 ? p + 100 : (p >= 10000 && p <= 100000 ? p + 2000 : p + 500);
        };

        const total = (calculatePrice(service.price) / 1000) * qty;
        if (db.users[ctx.from.id].saldo < total) return ctx.reply("❌ Saldo tidak cukup.");

        ctx.session.qty = qty;
        ctx.session.total = total;
        ctx.session.serviceName = service.name;
        ctx.session.step = 'waiting_confirmation';

        return ctx.reply(`\`\`\`\n📝 KONFIRMASI\n\n📦 : ${service.name}\n🎯 : ${state.link}\n🔢 : ${qty}\n💰 : Rp${total.toLocaleString()}\n\`\`\``, {
            parse_mode: 'MarkdownV2',
            ...Markup.inlineKeyboard([[Markup.button.callback('✅ PESAN SEKARANG', 'confirm_order')], [Markup.button.callback('❌ BATAL', 'back_to_start')]])
        });
    }
});

bot.action(/st_(\d+)/, async (ctx) => {
    const id = ctx.match[1];
    const res = await callApi('/status', { id: id });
    if (res.status) {
        ctx.reply(`📊 *STATUS #${id}*\n\nStatus: ${res.order_status.toUpperCase()}\nSisa: ${res.remains}\nBiaya: Rp${res.charge}`, { parse_mode: 'Markdown' });
    } else { ctx.answerCbQuery("API Error."); }
});

bot.action('menu_depo', async (ctx) => {
    ctx.session = { step: 'wait_depo' };
    await ctx.deleteMessage().catch(() => {});
    
    await ctx.reply(
`<b>💳 MENU DEPOSIT QRIS</b>

Silakan masukkan nominal deposit yang diinginkan.
<b>Minimal Rp1.000</b>

<i>Catatan:</i>
Biaya layanan <b>Rp1.000</b> per transaksi.`,
        {
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🔙 KEMBALI KE MENU", callback_data: "back_to_start" }]
                ]
            }
        }
    );
});

// Fungsi pembantu untuk mencairkan saldo ke user bot
async function prosesSaldoBerhasil(ctx, trxId, db) {
    const info = db.pending_depo[trxId];
    const u = db.users[info.userId];
    
    // Tambahkan saldo bersih (setelah dipotong fee Atlantic)
    u.saldo += info.get_balance;
    u.deposits.unshift({ 
        id: trxId, 
        amount: info.get_balance, 
        date: new Date().toLocaleString('id-ID') 
    });

    // Logika Referral (Bonus)
    if (!u.hasDeposited && info.amount >= 1000 && u.invitedBy) {
        const inviterId = u.invitedBy;
        if (db.users[inviterId]) {
            db.users[inviterId].saldo += 200;
            u.hasDeposited = true;
            ctx.telegram.sendMessage(inviterId, `🎁 <b>BONUS REFERRAL!</b>\n\nTeman Anda baru saja deposit. Saldo <b>Rp200</b> telah ditambahkan!`, { parse_mode: 'HTML' }).catch(()=>{});
        }
    }
    
    delete db.pending_depo[trxId];
    saveDb(db);

    await ctx.reply(`<b>✅ DEPOSIT BERHASIL!</b>\nSaldo sebesar Rp${info.get_balance.toLocaleString()} telah ditambahkan ke akun Anda.`, { parse_mode: "HTML" });
    return mainMenu(ctx);
}

bot.use(async (ctx, next) => {
    // Abaikan jika user menekan tombol join atau start awal
    if (ctx.chat?.type !== 'private') return next();
    
    // Daftar update yang perlu di cek subscription-nya
    const isCommand = ctx.message?.text?.startsWith('/');
    const isCallback = !!ctx.callbackQuery;

    if (isCommand || isCallback) {
        const isSubscribed = await checkSub(ctx);
        if (!isSubscribed) {
            // Tampilkan pesan wajib join seperti di atas
            return checkSubscriptionFlow(ctx, () => {}); 
        }
    }
    return next();
});

bot.action('confirm_order', async (ctx) => {
    const state = ctx.session;
    const CHANNEL_ID = '-1003648588091'; 
    const BOT_USERNAME = ctx.botInfo.username; 

    if (!state || !state.serviceId) return ctx.answerCbQuery("❌ Sesi Kadaluarsa");

    await ctx.answerCbQuery("🚀 Sedang memproses pesanan...");
    
    try {
        const res = await callApi('/order', { 
            service: state.serviceId, 
            target: state.link, 
            quantity: state.qty 
        });
        
        if (res.status) {
            const db = loadDb();
            const userId = ctx.from.id.toString();
            
            // 1. Potong Saldo User
            db.users[userId].saldo -= state.total;
            
            // 2. Simpan Data Pesanan Lengkap
            const orderDetail = {
                id: res.order,
                service: state.serviceName, 
                target: state.link,
                qty: state.qty,
                price: state.total,
                date: new Date().toLocaleString('id-ID')
            };
            db.users[userId].history.unshift(orderDetail);
            saveDb(db);

            // 3. Pesan Sukses ke User (Pindah ke HTML agar aman dari error karakter)
            const successMsg = `<b>✅ TRANSAKSI BERHASIL!</b>
━━━━━━━━━━━━━━━
🆔 <b>ID Order:</b> #${res.order}
📦 <b>Layanan:</b> ${state.serviceName}
🎯 <b>Target:</b> ${state.link}
🔢 <b>Jumlah:</b> ${state.qty.toLocaleString()}
💰 <b>Total Biaya:</b> Rp${state.total.toLocaleString('id-ID')}
📅 <b>Waktu:</b> ${orderDetail.date}
━━━━━━━━━━━━━━━
<i>Pesanan sedang diproses sistem. Cek status di menu Riwayat.</i>`;

            await ctx.editMessageText(successMsg, { 
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('📜 LIHAT RIWAYAT', 'hist_order_0')],
                    [Markup.button.callback('🏠 MENU UTAMA', 'back_to_start')]
                ])
            });

            // 4. Notifikasi ke Channel (HTML Mode)
            const channelNotif = `🛒 <b>REALTIME ORDER SUCCESS</b>
━━━━━━━━━━━━━━━
👤 <b>Customer:</b> ${ctx.from.first_name}
📦 <b>Layanan:</b> ${state.serviceName}
🎯 <b>Target:</b> ${state.link}
🔢 <b>Jumlah:</b> ${state.qty.toLocaleString()}
💰 <b>Harga:</b> Rp${state.total.toLocaleString('id-ID')}
📅 <b>Waktu:</b> ${orderDetail.date}
━━━━━━━━━━━━━━━
🚀 <b>Status:</b> PROSESSED (AUTO)
🌟 <b>Order via:</b> @${BOT_USERNAME}`;

            await ctx.telegram.sendMessage(CHANNEL_ID, channelNotif, { 
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                ...Markup.inlineKeyboard([
                    [Markup.button.url('🛒 MULAI ORDER SEKARANG', `https://t.me/${BOT_USERNAME}?start=order`)]
                ])
            }).catch(e => console.log("Gagal kirim ke channel (Cek apakah bot sudah Admin?):", e.message));

            // Bersihkan session
            ctx.session = null;

        } else { 
            // Handler Gagal
            await ctx.reply(`<b>❌ TRANSAKSI GAGAL</b>\n\nAlasan: ${res.msg || 'Gangguan provider.'}`, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.callback('🏠 MENU UTAMA', 'back_to_start')]])
            });
        }
    } catch (err) {
        console.error("Order Error:", err.message);
        ctx.answerCbQuery("❌ Terjadi kesalahan sistem.");
    }
});

bot.action('back_to_start', (ctx) => mainMenu(ctx));

bot.launch().then(() => console.log('Bot FayuPedia Fully Active!'));
