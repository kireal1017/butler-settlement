import './env.js';              // .env 를 가장 먼저 읽는다 (없으면 조용히 넘어간다)
import express from 'express';
import cors from 'cors';
import { migrate } from './db.js';
import api from './routes/api.js';
import { isLive } from './services/kapt.js';
import { configStatus } from './services/ocr.js';

/**
 * 이 서버는 **API 전용**이다. 화면은 client 의 Vite 개발 서버(:5173)가 띄우고
 * `/api` 만 이 포트로 프록시한다 (client/vite.config.js).
 *
 * 예전에는 `client/dist` 가 있으면 정적 서빙했는데, 빌드가 한 번 낡으면 :3001 에
 * 몇 단계 전 화면이 남아 "고쳤는데 왜 그대로냐"가 된다. 정적 서빙은 배포 환경의
 * 몫으로 넘기고 여기서는 걷어냈다.
 */
migrate();

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', api);

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, kaptLive: isLive(), time: new Date().toISOString() }));

/* API 밖의 경로는 여기 없다는 것을 분명히 알려 준다. 빈 404 가 오면
   "서버가 안 떴나" 와 "이 서버는 화면을 안 준다" 를 구분할 수 없다. */
app.use((req, res) => {
  res.status(404).json({
    error: req.path.startsWith('/api')
      ? `없는 API 경로입니다: ${req.method} ${req.path}`
      : `API 전용 서버입니다. 화면은 http://localhost:5173 입니다 (요청: ${req.path})`,
  });
});

app.use((err, _req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message ?? '서버 오류' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`▶ 버틀러 정산 API  http://localhost:${PORT}`);
  console.log(`  K-apt 실 API 연동: ${isLive() ? 'ON' : 'OFF (시드 데이터 사용)'}`);
  const ocr = configStatus();
  console.log(`  OCR: ${ocr.mode}${ocr.reason ? ` (${ocr.reason})` : ''}`);
  console.log(`  화면은 여기가 아닙니다 → http://localhost:5173 (client: npm run dev)`);
});
