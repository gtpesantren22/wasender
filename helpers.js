export function formatNumber(number) {
    // Hapus spasi, tanda plus, strip, dan karakter non-angka
    let cleaned = number.replace(/[^0-9]/g, '');

    // Kalau mulai dengan 0 → ganti dengan 62
    if (cleaned.startsWith('0')) {
        cleaned = '62' + cleaned.substring(1);
    }

    // Kalau belum ada kode negara dan bukan 62 → tambahkan 62
    if (!cleaned.startsWith('62')) {
        cleaned = '62' + cleaned;
    }

    // Kalau diawali +62 atau sudah 62 → biarkan
    if (number.startsWith('+62')) {
        number = number.slice(1) // buang +
    }

    if (cleaned.startsWith('8')) {
        cleaned = '62' + cleaned;
    }
    
    if (cleaned.startsWith('08')) {
        cleaned = '62' + cleaned.slice(1);
    }

    // Pastikan ada suffix WhatsApp JID
    return cleaned + '@s.whatsapp.net';
}

