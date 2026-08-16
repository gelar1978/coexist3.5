const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const { pool } = require('../db/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Setup Multer (simpan di memori sementara)
const upload = multer({ storage: multer.memoryStorage() });

// ==================== GET ALL STATIONS ====================
router.get('/', async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        
        // Mulai response JSON
        res.setHeader('Content-Type', 'application/json');
        res.write('{"success":true,"data":[');
        
        let isFirst = true;
        
        // Gunakan underlying non-promise connection untuk streaming agar hemat RAM (Anti-OOM)
        const query = connection.connection.query('SELECT name, lat, lng, operating_agency, address, province, usage_type, frequency, bandwidth FROM stations');
        
        query.on('error', (err) => {
            console.error('Stream error:', err);
            if (!res.headersSent) {
                res.status(500).json({ success: false, message: 'Gagal mengambil data stasiun' });
            } else {
                res.end(']}'); // tutup paksa jika error di tengah jalan
            }
        });

        query.on('result', (row) => {
            const mappedData = {
                id: row.name,
                lat: parseFloat(row.lat),
                lng: parseFloat(row.lng),
                operator: row.operating_agency || 'Lainnya',
                alamat: row.address || '-',
                provinsi: row.province || '-',
                satelit: row.usage_type || '-',
                frekuensi: row.frequency || '-',
                bandwidth: row.bandwidth || '-'
            };
            
            if (!isFirst) res.write(',');
            res.write(JSON.stringify(mappedData));
            isFirst = false;
        });

        query.on('end', () => {
            res.write(']}');
            res.end();
            connection.release();
        });

    } catch (error) {
        console.error('Error fetching stations:', error);
        if (connection) connection.release();
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Gagal mengambil data stasiun' });
        }
    }
});

// ==================== UPLOAD EXCEL (Parse JSON) ====================
// Kita tidak pakai multer karena proxy PHP tidak support multipart/form-data dengan baik.
// Client (browser) akan mem-parse Excel dan mengirim array JSON ke endpoint ini.
router.post('/upload', authenticate, async (req, res) => {
    try {
        const rawData = req.body.data;
        
        if (!rawData || !Array.isArray(rawData) || rawData.length === 0) {
            return res.status(400).json({ success: false, message: 'Data Excel kosong atau tidak valid' });
        }

        let insertedCount = 0;
        let skippedCount = 0;

        // Loop setiap baris dan masukkan ke database
        for (const row of rawData) {
            // Mapping nama kolom dinamis & case-insensitive
            const lowerRow = {};
            for (let key in row) {
                lowerRow[key.toLowerCase().trim()] = row[key];
            }

            const lat = lowerRow['lat dec'] || lowerRow['latitude'] || lowerRow['lat'];
            const lng = lowerRow['long dec'] || lowerRow['longitude'] || lowerRow['long'] || lowerRow['lon'];
            
            // Nama stasiun bumi wajib ada, jika tidak ada di Excel (spt file Telkom University), gunakan fallback
            let name = lowerRow['earth station name'] || lowerRow['name'] || lowerRow['nama stasiun'] || lowerRow['id stasiun bumi'] || null;
            if (!name && lat != null && lng != null) {
                name = `Station-${lat}-${lng}`;
            }

            // Opsional
            const stationId = lowerRow['id stasiun bumi'] || lowerRow['id'] || null;
            const operatingAgency = lowerRow['operating agency'] || lowerRow['kdepum'] || null;
            const address = lowerRow['alamat'] || null;
            const province = lowerRow['provinsi'] || null;
            const usageType = lowerRow['jenis penggunaan'] || null;
            const antenna = lowerRow['antenna diameter'] || lowerRow['antena_h'] || null;
            const bandwidth = lowerRow['bandwidth (mhz)'] || null;
            const frequency = lowerRow['frequency (mhz)'] || lowerRow['downlink (mhz)'] || lowerRow['downlink'] || lowerRow['freq'] || null;
            const isr = lowerRow['nomor isr'] || null;

            // Validasi data wajib (jika koordinat tidak ada, skip)
            if (!name || lat == null || lng == null) {
                skippedCount++;
                continue;
            }

            try {
                // Insert dengan IGNORE untuk skip duplikat berdasarkan UNIQUE KEY (name, lat, lng)
                const [result] = await pool.query(`
                    INSERT IGNORE INTO stations 
                    (name, lat, lng, station_id, operating_agency, address, province, usage_type, antenna_diameter, frequency, bandwidth, isr_number) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [name, parseFloat(lat), parseFloat(lng), stationId, operatingAgency, address, province, usageType, antenna, frequency, bandwidth, isr]);
                
                if (result.affectedRows > 0) {
                    insertedCount++;
                } else {
                    skippedCount++; // Duplikat
                }
            } catch (err) {
                console.error('Error insert row:', err.message);
                skippedCount++;
            }
        }

        // Catat aktivitas
        try {
            await pool.query(
                'INSERT INTO user_logs (user_id, action, ip_address, user_agent) VALUES (?, ?, ?, ?)',
                [req.user.id, 'upload_stations', req.ip || req.connection.remoteAddress, req.headers['user-agent']]
            );
        } catch(e) {}

        res.json({
            success: true,
            message: `Berhasil memproses Excel. Data baru dimasukkan: ${insertedCount}. Data dilewati/duplikat: ${skippedCount}.`
        });

    } catch (error) {
        console.error('Upload excel error:', error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan server saat memproses file Excel' });
    }
});

// ==================== GET ALL BTS STATIONS ====================
router.get('/bts', async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        
        res.setHeader('Content-Type', 'application/json');
        res.write('{"success":true,"data":[');
        
        let isFirst = true;
        
        const query = connection.connection.query('SELECT longitude, latitude, azimuth, antena_h, freq, technology, operator, district, city, province FROM bts_stations');
        
        query.on('error', (err) => {
            console.error('Stream error:', err);
            if (!res.headersSent) {
                res.status(500).json({ success: false, message: 'Gagal mengambil data BTS' });
            } else {
                res.end(']}');
            }
        });

        query.on('result', (row) => {
            const mappedData = {
                id: `BTS-${row.freq}-${row.technology}`,
                lat: parseFloat(row.latitude),
                lng: parseFloat(row.longitude),
                azimuth: row.azimuth || '-',
                antena_h: row.antena_h || '-',
                freq: row.freq || '-',
                technology: row.technology || '-',
                operator: row.operator || 'Lainnya',
                district: row.district || '-',
                city: row.city || '-',
                province: row.province || '-'
            };
            
            if (!isFirst) res.write(',');
            res.write(JSON.stringify(mappedData));
            isFirst = false;
        });

        query.on('end', () => {
            res.write(']}');
            res.end();
            connection.release();
        });

    } catch (error) {
        console.error('Error fetching BTS stations:', error);
        if (connection) connection.release();
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Gagal mengambil data BTS' });
        }
    }
});

// ==================== UPLOAD EXCEL BTS ====================
router.post('/upload-bts', authenticate, async (req, res) => {
    try {
        const rawData = req.body.data;
        
        if (!rawData || !Array.isArray(rawData) || rawData.length === 0) {
            return res.status(400).json({ success: false, message: 'Data Excel kosong atau tidak valid' });
        }

        let insertedCount = 0;
        let skippedCount = 0;

        for (const row of rawData) {
            const lowerRow = {};
            for (let key in row) {
                lowerRow[key.toLowerCase().trim()] = row[key];
            }

            const lat = lowerRow['latitude'] || lowerRow['lat'] || lowerRow['lat dec'];
            const lng = lowerRow['longitude'] || lowerRow['long'] || lowerRow['long dec'] || lowerRow['lon'];
            
            if (lat == null || lng == null) {
                skippedCount++;
                continue;
            }

            const azimuth = lowerRow['azimuth'] || null;
            const antena_h = lowerRow['antena_h'] || null;
            const freq = lowerRow['freq'] || lowerRow['frequency'] || null;
            const technology = lowerRow['k'] || lowerRow['technology'] || null;
            
            // Auto detect operator from technology (e.g. IOH_2G -> Indosat Ooredoo)
            let operator = lowerRow['operator'] || null;
            if (!operator && technology) {
                const techStr = String(technology).toUpperCase();
                if (techStr.includes('IOH')) operator = 'Indosat Ooredoo';
                else if (techStr.includes('TSEL') || techStr.includes('TELKOMSEL')) operator = 'Telkomsel';
                else if (techStr.includes('XL')) operator = 'XL Axiata';
                else if (techStr.includes('SMARTFREN')) operator = 'Smartfren';
                else if (techStr.includes('HCPT') || techStr.includes('TRI')) operator = 'Tri';
            }

            const district = lowerRow['wadmkc'] || lowerRow['kecamatan'] || null;
            const city = lowerRow['wadmkk'] || lowerRow['kabupaten'] || null;
            const province = lowerRow['wadmpr'] || lowerRow['provinsi'] || null;

            try {
                const [result] = await pool.query(`
                    INSERT IGNORE INTO bts_stations 
                    (longitude, latitude, azimuth, antena_h, freq, technology, operator, district, city, province) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [parseFloat(lng), parseFloat(lat), azimuth, antena_h, freq, technology, operator, district, city, province]);
                
                if (result.affectedRows > 0) {
                    insertedCount++;
                } else {
                    skippedCount++;
                }
            } catch (err) {
                console.error('Error insert BTS row:', err.message);
                skippedCount++;
            }
        }

        try {
            await pool.query(
                'INSERT INTO user_logs (user_id, action, ip_address, user_agent) VALUES (?, ?, ?, ?)',
                [req.user.id, 'upload_bts', req.ip || req.connection.remoteAddress, req.headers['user-agent']]
            );
        } catch(e) {}

        res.json({
            success: true,
            message: `Berhasil memproses Excel BTS. Data baru dimasukkan: ${insertedCount}. Data dilewati/duplikat: ${skippedCount}.`
        });

    } catch (error) {
        console.error('Upload excel BTS error:', error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan server saat memproses file Excel BTS' });
    }
});

module.exports = router;
