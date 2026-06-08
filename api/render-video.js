// api/render-video.js
// Serverless function (Vercel) — recebe frames dos slides + intro/fecho MP4
// e devolve o vídeo final concatenado e faz upload para o Vercel Blob.
//
// Fluxo:
//  1. Recebe JSON: { frames: [dataURL,...], fps, introBase64?, outroBase64? }
//  2. Escreve frames em /tmp como PNG sequenciais
//  3. FFmpeg: frames -> vídeo dos slides
//  4. Se houver intro/outro, concatena: intro + slides + outro
//  5. Faz upload para o Vercel Blob e devolve URL público

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { put } = require('@vercel/blob');

ffmpeg.setFfmpegPath(ffmpegPath);

export const config = {
  api: {
    bodyParser: { sizeLimit: '50mb' }
  }
};

function dataUrlToBuffer(dataUrl) {
  const base64 = dataUrl.split(',')[1];
  return Buffer.from(base64, 'base64');
}

function run(cmd) {
  return new Promise((resolve, reject) => {
    cmd.on('end', resolve).on('error', reject).run();
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'led-'));

  try {
    const { frames, fps = 30, introBase64, outroBase64, width = 1920, height = 1080 } = req.body;

    if (!frames || !frames.length) {
      return res.status(400).json({ error: 'Sem frames para processar.' });
    }

    // 1. Escrever frames como PNG sequenciais
    frames.forEach((frame, i) => {
      const buf = dataUrlToBuffer(frame);
      const fname = path.join(workDir, `frame_${String(i).padStart(5, '0')}.png`);
      fs.writeFileSync(fname, buf);
    });

    // 2. Frames -> vídeo dos slides
    const slidesVideo = path.join(workDir, 'slides.mp4');
    await run(
      ffmpeg()
        .input(path.join(workDir, 'frame_%05d.png'))
        .inputOptions([`-framerate ${fps}`])
        .videoCodec('libx264')
        .outputOptions([
          '-pix_fmt yuv420p',
          `-vf scale=${width}:${height}`,
          '-preset fast',
          '-crf 18'
        ])
        .output(slidesVideo)
    );

    // 3. Preparar lista de segmentos para concatenação
    const segments = [];

    if (introBase64) {
      const introPath = path.join(workDir, 'intro.mp4');
      fs.writeFileSync(introPath, dataUrlToBuffer(introBase64));
      // Normalizar intro para mesma resolução/codec
      const introNorm = path.join(workDir, 'intro_norm.mp4');
      await run(
        ffmpeg(introPath)
          .videoCodec('libx264')
          .outputOptions(['-pix_fmt yuv420p', `-vf scale=${width}:${height}`, '-r ' + fps, '-preset fast', '-crf 18', '-an'])
          .output(introNorm)
      );
      segments.push(introNorm);
    }

    segments.push(slidesVideo);

    if (outroBase64) {
      const outroPath = path.join(workDir, 'outro.mp4');
      fs.writeFileSync(outroPath, dataUrlToBuffer(outroBase64));
      const outroNorm = path.join(workDir, 'outro_norm.mp4');
      await run(
        ffmpeg(outroPath)
          .videoCodec('libx264')
          .outputOptions(['-pix_fmt yuv420p', `-vf scale=${width}:${height}`, '-r ' + fps, '-preset fast', '-crf 18', '-an'])
          .output(outroNorm)
      );
      segments.push(outroNorm);
    }

    // 4. Concatenar (se houver intro/outro), senão usar slides directamente
    let finalVideo = slidesVideo;
    if (segments.length > 1) {
      const concatList = path.join(workDir, 'concat.txt');
      fs.writeFileSync(concatList, segments.map(s => `file '${s}'`).join('\n'));
      finalVideo = path.join(workDir, 'final.mp4');
      await run(
        ffmpeg()
          .input(concatList)
          .inputOptions(['-f concat', '-safe 0'])
          .outputOptions(['-c copy'])
          .output(finalVideo)
      );
    }

    // 5. Upload para o Vercel Blob
    const videoBuffer = fs.readFileSync(finalVideo);

    // Generate a unique filename
    const filename = `led-mockup-${Date.now()}.mp4`;

    const blob = await put(filename, videoBuffer, {
      access: 'public',
      contentType: 'video/mp4',
      token: process.env.BLOB_READ_WRITE_TOKEN
    });

    res.status(200).json({
      success: true,
      videoUrl: blob.url,
      size: videoBuffer.length
    });

  } catch (err) {
    console.error('Render error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    // Limpar /tmp
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
  }
}
