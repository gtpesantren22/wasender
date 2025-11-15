import pool from "./db.js";

async function testConnection() {
    try {
        const [rows] = await pool.query("SELECT NOW() AS waktu");
        console.log("Koneksi berhasil! Waktu DB:", rows[0].waktu);
    } catch (err) {
        console.error("Koneksi gagal:", err);
    } finally {
        pool.end(); // tutup pool
    }
}

testConnection();
