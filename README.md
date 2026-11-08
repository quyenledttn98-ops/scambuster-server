# ScamBuster — Bản có máy chủ (deploy lên host ngoài)

Bản này sinh ra để sửa đúng lỗi đã gặp trên link tĩnh Netlify
(`https://build-a6e9fd.netlify.app`): tài khoản chỉ lưu theo máy, đăng nhập
thêm tài khoản khác thì tài khoản cũ "biến mất" khỏi danh sách, tải lại trang
là mất hết — vì bản tĩnh không có máy chủ chung. Bản này có máy chủ thật
(Node + SQLite), giống cách web Manus cũ vận hành.

## Bản này làm được gì (so với bản tĩnh)

| Vấn đề ở bản tĩnh | Bản có máy chủ này |
|---|---|
| Tài khoản chỉ trong bộ nhớ trang, tải lại là mất | Tài khoản lưu trên server (SQLite), đăng nhập ở **bất kỳ thiết bị nào** cũng đúng tiến trình |
| Danh sách người chơi chỉ có 20 người mẫu + 1 tài khoản đang đăng nhập | `GET /api/state` trả **toàn bộ người chơi** (người mẫu + người thật), BXH / tab Người chơi thấy tất cả người đã đăng nhập |
| Đăng nhập tài khoản cũ phải gõ lại tên, không thấy danh sách tài khoản | Modal đăng nhập hiện danh sách **"Tài khoản đã đăng ký trên máy chủ"** — bấm tên là điền sẵn |
| Điểm danh lệch giữa header và thanh điểm danh | Điểm danh do **server quyết định theo ngày Việt Nam**, lần đầu = **Ngày 1**, 1 ngày chỉ nhận 1 lần (+15 ScamCoins, +5 XP) |
| Nhắn tin chỉ là trả lời tự động | Nhắn tin thật giữa 2 người chơi (`/api/messages`), người mẫu vẫn trả lời tự động như cũ |
| Đấu trường chỉ đấu Bot | Thêm **đấu trực tiếp 2 người** (Quiz – Race – Quiz, thắng 2/3 lượt) qua `/api/arena/*` (polling HTTP, không cần WebSocket) |
| Không có số liệu cho giáo viên | `GET /api/players.csv` xuất bảng ẩn danh (tên, cấp, XP, coins, streak, wins) phục vụ NCKH |

Giữ nguyên từ bản tĩnh: giao diện, nhân vật 3D nam/nữ, Quiz 600 câu
(6 chặng, mỗi lượt 10 câu, ≥7/10 mới mở chặng sau), Race Quest, kho đồ
21 món, 12 chiêu lừa, Hộp thư, Soi link, cấp tối đa 100 — mỗi cấp đúng
10.000 XP, một tổng XP chung cho mọi trò.

## Cấu trúc thư mục

```
server-deploy/
├── server.js          # Server Node (chi dung thu vien co san, khong can npm install)
├── public/
│   ├── index.html     # Giao dien game — ban sao Y NGUYEN file tinh hien tai
│   └── sync.js        # Lop dong bo: noi game tinh voi API server (khong sua game goc)
├── package.json       # start: node server.js (Node >= 22)
├── render.yaml        # Blueprint de Render tu tao service
├── test-smoke.sh      # Kiem thu nhanh bang curl (dang ky, check-in, nhan tin, dau PvP...)
├── .env.example       # Bien moi truong mau
└── data/              # SQLite (scambuster.db) — KHONG day len Git (da co trong .gitignore)
```

Cách nó hoạt động: server phục vụ `public/index.html` và tự chèn
`<script src="/sync.js"></script>` vào cuối trang. `sync.js` chạy sau game,
"vá" các hàm global sẵn có (`authSubmit`, `saveAccount`, `doCheckin`,
`sendChat`, `logout`, `renderAuth`) sang gọi API server, còn khi mất mạng
thì tự rơi về chế độ chơi local như bản tĩnh cũ — game không bao giờ vỡ
vì lỗi server.

## Chạy thử trên máy của bạn (local)

```bash
cd server-deploy
node server.js            # mac dinh http://localhost:3000
# Thu nghiem day du:
PORT=3000 DATA_DIR=/tmp/sb-test node server.js &
PORT=3000 DATA_DIR=/tmp/sb-test bash test-smoke.sh
```

Yêu cầu: **Node.js 22 trở lên** (dùng `node:sqlite` có sẵn, không cần cài
gói ngoài). Kiểm tra bằng `node --version`. Nếu host dùng Node cũ hơn,
đặt `STORE=json` để dùng file JSON thay cho SQLite.

Mở `http://localhost:3000` trên 2 trình duyệt / 2 máy khác nhau trong cùng
mạng: đăng ký tài khoản ở máy 1, đăng nhập cùng tên + mật khẩu ở máy 2 sẽ
thấy đúng tiến trình, và cả 2 đều hiện trong tab Người chơi của nhau.

## Deploy lên Render (khuyên dùng — miễn phí)

Cần có: **tài khoản GitHub** (để đẩy code) và **tài khoản Render**
(đăng ký miễn phí bằng Google/GitHub). Chưa có 2 tài khoản này thì chưa
deploy được — đây là thứ duy nhất còn thiếu, code đã xong.

1. Đẩy thư mục `server-deploy/` lên GitHub thành 1 repo mới, ví dụ
   `scambuster-server` (đẩy cả thư mục, **không** đẩy thư mục `data/`).
2. Vào [Render Dashboard](https://dashboard.render.com) → **New → Blueprint**
   → chọn repo vừa đẩy. Render đọc `render.yaml` và tự tạo web service
   (plan free, `npm install` rồi `node server.js`).
   Hoặc làm tay: **New → Web Service** → chọn repo → Build Command
   `npm install` → Start Command `node server.js` → chọn plan Free.
3. Chờ deploy xong, Render cấp link dạng
   `https://scambuster-server-xxxx.onrender.com` — đó là link công khai mới.
   Mở link, kiểm tra `https://<link>/api/health` trả `{"ok":true,...}`.
4. Lưu ý gói Free: Render tắt máy sau 15 phút không có ai vào (lần vào
   đầu sau đó sẽ chậm ~30–60 giây để máy "tỉnh" lại — bình thường), và
   **dữ liệu SQLite sẽ mất khi redeploy**. Muốn giữ lâu dài cho lớp học:
   nâng cấp plan trả phí rồi gắn **Persistent Disk** (mount vào thư mục
   `data`), hoặc chuyển sang Postgres (cần sửa thêm lớp store — đã thiết
   kế sẵn interface để thay, xem `server.js` phần "LƯU TRỮ").

## Deploy lên Railway (phương án 2)

1. Đẩy code lên GitHub như trên.
2. Vào [Railway](https://railway.app) → **New Project → Deploy from GitHub
   repo** → chọn repo. Railway tự nhận `package.json` và chạy `npm start`.
3. Vào tab **Settings → Networking → Generate Domain** để lấy link công khai.
4. Railway cũng dùng ổ đĩa tạm thời như Render free — muốn giữ dữ liệu lâu
   dài thì gắn **Volume** vào thư mục `data` (Railway → Service → Volumes).

## API (tóm tắt — đầy đủ trong code `server.js`)

| Endpoint | Mô tả |
|---|---|
| `GET /api/health` | Kiểm tra server sống, số người chơi / đang online |
| `GET /api/state` | Công khai, không cần đăng nhập: toàn bộ người chơi (online trước, rồi XP giảm dần) |
| `GET /api/players.csv` | Xuất bảng ẩn danh cho giáo viên (không có mật khẩu) |
| `POST /api/register` | `{name, pass, gender}` — tên chuẩn hoá (trim, gộp khoảng trắng, lowercase); mật khẩu lưu dạng salt + scrypt, không lưu mật khẩu gốc |
| `POST /api/login` | `{name, pass}` — trả token (sống 30 ngày) + toàn bộ tiến trình |
| `POST /api/me` | `{token}` — lấy lại tiến trình khi đổi máy / tải lại trang |
| `POST /api/heartbeat` | `{token}` — gọi mỗi 25 giây; online = thấy trong 60 giây |
| `POST /api/checkin` | `{token}` — server quyết định, lần đầu = Ngày 1, +15 coins / +5 XP, 1 ngày 1 lần |
| `POST /api/sync` | `{token, state}` — đồng bộ XP/coins/kho đồ/Quiz/Hộp thư (XP lấy max(server, client); streak do server nắm) |
| `POST /api/messages/send` | `{token, to, body}` — nhắn tin riêng (1–500 ký tự) |
| `GET /api/messages?token=&with=TEN` | Lấy hội thoại 2 chiều, đánh dấu đã đọc |
| `POST /api/arena/quickmatch` | Vào hàng chờ đấu trực tiếp; có người chờ thì ghép ngay |
| `POST /api/arena/status` | Hỏi trạng thái trận (client hỏi mỗi 2–3 giây) |
| `POST /api/arena/submit-round` | `{matchId, roundNo, score}` — nộp điểm từng lượt (Quiz–Race–Quiz) |
| `POST /api/arena/forfeit` | Bỏ trận (đối thủ thắng 2–0) |
| `POST /api/logout` | Xoá session |

Thưởng đấu trực tiếp (giống bản tĩnh đấu Bot): thắng trận +30 XP / +25 coins /
+1 win; thua +8 XP / +5 coins; hoà +12 XP / +10 coins.

## Tài khoản cũ — đọc kỹ trước khi dùng link mới

- **20 người mẫu** (Tuấn Anh, Văn An, Bảo Ngọc...) được seed sẵn y như bản
  tĩnh, chỉ để BXH trông sinh động; họ **không đăng nhập được** (không có
  mật khẩu) và không nhận thưởng thật.
- **Tài khoản thật cũ không chuyển sang được**: mật khẩu của tài khoản
  **Quyên Lê** (12 XP, 16 ScamCoins, chuỗi 1, check-in 08/11/2026 — theo dữ
  liệu bản fullstack trong Muse) chỉ tồn tại dưới dạng hash trong Muse, không
  lấy ra được. Quyên Lê cần **đăng ký lại đúng tên "Quyên Lê" trên link mới**
  (mật khẩu tự đặt lại); tiến trình cũ 12 XP rất nhỏ, chơi 1–2 lượt Quiz là
  lấy lại được. Đây là giới hạn thật, không phải lỗi.
- Người chơi mới đăng ký trên link mới sẽ hiện ngay trong tab Người chơi
  trên mọi máy khác (sau tối đa ~20 giây, là chu kỳ poll của client).

## Kết quả kiểm thử (08/11/2026, chạy local trên máy này)

- **Smoke test `test-smoke.sh`: 18/18 đạt** với store SQLite
  (`node:sqlite`), và **18/18 đạt** với store JSON dự phòng (`STORE=json`):
  health, state có 20 người mẫu, đăng ký, chặn trùng tên (chuẩn hoá),
  chặn sai mật khẩu, state thấy cả 2 tài khoản thật, check-in lần đầu =
  Ngày 1, check-in lần 2 cùng ngày bị chặn, sync XP/coins/kho đồ,
  `/api/me` trả đúng tiến trình, gửi + đọc tin nhắn riêng, ghép đấu trực
  tiếp 2 người, đấu Quiz–Race thắng 2/3 lượt và kết thúc + thưởng XP,
  xuất CSV ẩn danh, heartbeat.
- **Bền dữ liệu**: kill server rồi khởi động lại cùng `DATA_DIR`, tài khoản
  Quyên Lê vẫn còn nguyên trong `/api/state` (đã kiểm chứng).
- **Thưởng đấu PvP đã kiểm chứng trong DB**: người thắng 150 XP / 65 coins /
  3 wins (gồm +30 XP / +25 coins / +1 win từ trận đấu), người thua 8 XP /
  5 coins; trận `finished 2–0, awarded=1` (không thưởng 2 lần).
- **Chưa kiểm thử trong trình duyệt thật**: `sync.js` đã qua `node --check`
  và đã đối chiếu tĩnh — 22 tên hàm/biến nó dùng đều có thật trong game
  gốc — nhưng chưa chạy thử trong Chrome/Firefox thật, và chưa mở link
  trên 2 máy thật để bấm tay đăng nhập. **Phải làm bước này trước khi gửi
  link cho học sinh.**

## Còn thiếu / chưa làm (nói thật)

- **Chưa deploy thật**: chưa có link công khai nào của bản này — cần tài
  khoản GitHub + Render/Railway (xem mục Deploy ở trên). Không bịa link.
- **Dữ liệu chưa bền trên gói free**: SQLite trên ổ đĩa tạm của Render/
  Railway free sẽ mất khi redeploy. Cần Persistent Disk/Volume (trả phí)
  hoặc Postgres để giữ lâu dài cho lớp học.
- **Đấu trực tiếp dùng polling HTTP** (hỏi mỗi 2–3 giây), không phải thời
  gian thực qua WebSocket như game lớn — đủ cho lớp học, nhưng 2 người phải
  cùng bấm "Tìm trận" trong vòng ~2 phút mới ghép được nhau (hàng chờ hết
  hạn sau 120 giây).
- **Chưa có trang quản trị / chống gian lận**: ai biết tên người khác vẫn
  phải có mật khẩu mới đăng nhập được, nhưng chưa có khoá tài khoản sau
  nhiều lần sai mật khẩu, chưa có xoá người chơi / đặt lại mật khẩu cho
  giáo viên. Chỉ có giới hạn 30 lượt đăng nhập/phút/IP.
- **Chưa kiểm thử chéo thiết bị thật bằng trình duyệt**: đã kiểm thử bằng
  curl + 2 token khác nhau trên cùng máy, và `sync.js` đã đối chiếu tĩnh
  với game gốc (xem mục "Kết quả kiểm thử"). Trước khi gửi link cho học
  sinh, nên mở link trên 2 máy thật và đăng nhập cùng 1 tài khoản để xác
  nhận, vì `sync.js` chưa chạy thử trong trình duyệt thật.
