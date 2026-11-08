#!/usr/bin/env bash
# Smoke test nhanh cho ScamBuster server (chay sau khi khoi dong server local).
# Cach dung:  PORT=3000 DATA_DIR=/tmp/sb-test bash test-smoke.sh
#   (mo terminal khac chay: PORT=3000 DATA_DIR=/tmp/sb-test node server.js truoc)
set -u
BASE="${BASE_URL:-http://localhost:${PORT:-3000}}"
fail=0
check() { # check "mo ta" <lenh...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "OK   $desc"; else echo "FAIL $desc"; fail=1; fi
}
j() { curl -s -m 5 "$@"; }

echo "== $BASE =="
curl -s -m 5 "$BASE/api/health" | grep -q '"ok":true' && echo "OK   health" || { echo "FAIL health"; fail=1; }
STATE=$(j "$BASE/api/state")
echo "$STATE" | grep -q 'Tuấn Anh' && echo "OK   state co 20 nguoi mau" || { echo "FAIL state co 20 nguoi mau"; fail=1; }
echo "$STATE" | grep -q 'Quyên Lê' && echo "NOTE state co Quyên Lê (khong mong doi o lan chay dau)" || echo "OK   state chua co tai khoan that (dung nhu thiet ke)"

REG=$(j -X POST "$BASE/api/register" -H 'Content-Type: application/json' -d '{"name":"Quyên Lê","pass":"123456","gender":"female"}')
echo "$REG" | grep -q '"ok":true' && echo "OK   register Quyen Le" || { echo "FAIL register: $REG"; fail=1; }
TOKEN=$(echo "$REG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
[ -n "$TOKEN" ] || { echo "FAIL khong lay duoc token"; exit 1; }

DUP=$(j -X POST "$BASE/api/register" -H 'Content-Type: application/json' -d '{"name":"quyên   lê","pass":"123456","gender":"female"}')
echo "$DUP" | grep -q 'da co nguoi dung' && echo "OK   dang ky trung ten (chuan hoa) bi chan" || { echo "FAIL trung ten: $DUP"; fail=1; }

BAD=$(j -X POST "$BASE/api/login" -H 'Content-Type: application/json' -d '{"name":"Quyên Lê","pass":"sai"}')
echo "$BAD" | grep -q 'Mat khau chua dung' && echo "OK   sai mat khau bi chan" || { echo "FAIL sai mat khau: $BAD"; fail=1; }

REG2=$(j -X POST "$BASE/api/register" -H 'Content-Type: application/json' -d '{"name":"Minh Anh","pass":"123456","gender":"male"}')
TOKEN2=$(echo "$REG2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
[ -n "$TOKEN2" ] && echo "OK   register Minh Anh" || { echo "FAIL register Minh Anh"; fail=1; }

STATE2=$(j "$BASE/api/state")
echo "$STATE2" | grep -q 'Minh Anh' && echo "OK   state thay ca 2 tai khoan that" || { echo "FAIL state thieu tai khoan that"; fail=1; }

CK1=$(j -X POST "$BASE/api/checkin" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}")
echo "$CK1" | grep -q '"streak":1' && echo "OK   check-in lan dau = Ngay 1 (+15 coins, +5 XP)" || { echo "FAIL checkin 1: $CK1"; fail=1; }
CK2=$(j -X POST "$BASE/api/checkin" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}")
echo "$CK2" | grep -q '"already":true' && echo "OK   check-in lan 2 cung ngay bi chan" || { echo "FAIL checkin 2: $CK2"; fail=1; }

SYNC=$(j -X POST "$BASE/api/sync" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"state\":{\"xp\":120,\"coins\":40,\"wins\":2,\"owned\":[\"visor\"],\"equipped\":{\"phu-kien\":\"visor\"},\"quizPassed\":[\"Tin nhắn\"],\"quizDoneIds\":[1,2],\"threads\":{},\"unread\":{}}}")
echo "$SYNC" | grep -q '"xp":120' && echo "OK   sync XP/coins/kho do" || { echo "FAIL sync: $SYNC"; fail=1; }

ME=$(j -X POST "$BASE/api/me" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}")
echo "$ME" | grep -q 'visor' && echo "OK   /api/me tra dung tien trinh (mo dung o may khac)" || { echo "FAIL me: $ME"; fail=1; }

MSG=$(j -X POST "$BASE/api/messages/send" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"to\":\"Minh Anh\",\"body\":\"Chao ban, cung dau khong?\"}")
echo "$MSG" | grep -q '"ok":true' && echo "OK   gui tin nhan rieng" || { echo "FAIL gui tin: $MSG"; fail=1; }
THREAD=$(curl -s -m 5 --get --data-urlencode "token=$TOKEN2" --data-urlencode "with=Quyên Lê" "$BASE/api/messages")
echo "$THREAD" | grep -q 'Chao ban' && echo "OK   nguoi nhan doc duoc tin" || { echo "FAIL doc tin: $THREAD"; fail=1; }

QM1=$(j -X POST "$BASE/api/arena/quickmatch" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}")
MID=$(echo "$QM1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('match',{}).get('id',''))")
QM2=$(j -X POST "$BASE/api/arena/quickmatch" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN2\"}")
echo "$QM2" | grep -q '"status":"playing"' && echo "OK   ghep dau truc tiep 2 nguoi" || { echo "FAIL ghep dau: $QM2"; fail=1; }
for R in 1 2; do
  j -X POST "$BASE/api/arena/submit-round" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"matchId\":$MID,\"roundNo\":$R,\"score\":900}" >/dev/null
  j -X POST "$BASE/api/arena/submit-round" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN2\",\"matchId\":$MID,\"roundNo\":$R,\"score\":500}" >/dev/null
done
FIN=$(j -X POST "$BASE/api/arena/status" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"matchId\":$MID}")
echo "$FIN" | grep -q '"status":"finished"' && echo "OK   dau Quiz-Race thang 2/3 luot, ket thuc + thuong XP" || { echo "FAIL ket thuc tran: $FIN"; fail=1; }

CSV=$(curl -s -m 5 "$BASE/api/players.csv")
echo "$CSV" | grep -q 'Quyên Lê' && echo "OK   xuat CSV an danh cho giao vien" || { echo "FAIL CSV"; fail=1; }

HB=$(j -X POST "$BASE/api/heartbeat" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}")
echo "$HB" | grep -q '"ok":true' && echo "OK   heartbeat" || { echo "FAIL heartbeat"; fail=1; }

[ "$fail" = 0 ] && echo "TAT CA SMOKE TEST DAT" || { echo "CO TEST FAIL"; exit 1; }
