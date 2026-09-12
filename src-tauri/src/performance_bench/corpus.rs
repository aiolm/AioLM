//! Original, deterministic benchmark material. These are synthetic workload
//! samples, not excerpts from copyrighted books or downloaded repositories.
pub(super) fn text(profile: &str, min_bytes: usize) -> String {
    let seed = match profile {
        "code_python" => r#"from dataclasses import dataclass
from collections import defaultdict

@dataclass(frozen=True)
class Reading:
    station: str
    temperature: float
    samples: int

def summarize(readings: list[Reading]) -> dict[str, float]:
    totals = defaultdict(float)
    counts = defaultdict(int)
    for reading in readings:
        if reading.samples <= 0:
            continue
        totals[reading.station] += reading.temperature * reading.samples
        counts[reading.station] += reading.samples
    return {station: value / counts[station] for station, value in totals.items()}

def test_summary():
    rows = [Reading('harbor', 12.5, 2), Reading('harbor', 15.0, 1)]
    assert abs(summarize(rows)['harbor'] - 40.0 / 3.0) < 0.001
"#,
        "code_mixed" => r#"// TypeScript: validate a measurement before adding it to the dashboard.
type Sample = { name: string; elapsedMs: number; tokens: number };
export function rate(sample: Sample): number | null {
  if (sample.elapsedMs <= 0 || !Number.isFinite(sample.elapsedMs)) return null;
  return sample.tokens * 1000 / sample.elapsedMs;
}
// Rust: retain the successful values while keeping failures observable.
fn successful(values: &[Result<u64, String>]) -> Vec<u64> {
    values.iter().filter_map(|item| item.as_ref().ok().copied()).collect()
}
-- SQL: compare the daily workload of each station.
SELECT station, COUNT(*) AS samples, AVG(temperature) AS mean_temperature
FROM observations WHERE measured_at >= '2025-01-01'
GROUP BY station ORDER BY samples DESC;
"#,
        "novel_ko" => "새벽 안개가 강 위로 천천히 흘렀다. 지윤은 오래된 역의 창문을 열고 첫 열차가 도착하기를 기다렸다. 어젯밤 책상 위에 놓인 지도에는 이름 없는 섬과 작은 등대가 그려져 있었다. 역장은 그곳에 가려면 해가 지기 전에 나루터에 도착해야 한다고 말했다. 지윤은 따뜻한 차를 보온병에 담고 수첩의 빈 페이지에 오늘의 날짜를 적었다. 플랫폼 끝에서 고양이 한 마리가 기지개를 켰다. 기적 소리가 산 너머에서 들려오자, 그녀는 가방을 어깨에 메고 아직 아무도 밟지 않은 눈 위에 첫 발자국을 남겼다.\n",
        "novel_en" => "The harbor clock stopped just before sunrise. Mara noticed it while carrying a basket of folded maps to the workshop. Across the water, a small boat waited beside the old lighthouse, its sail moving gently in the wind. Her brother had left a note beneath the door: the northern channel was open again. She checked the weather, sharpened her pencil, and marked a route along the quieter shore. When the baker opened his window, the street filled with the smell of warm bread. Mara bought two rolls, placed them beside the compass, and walked toward the landing. She had spent years drawing places she had never seen. Today she would begin with the island nearest home.\n",
        "novel_ja" => "夜明けの港には、まだ船の音が聞こえなかった。遥は古い時計台の下で地図を広げ、昨日まで描かれていなかった細い道を指でたどった。道は森を抜けて、白い灯台のある岬へ続いていた。祖父の手紙には、潮が引く前に橋を渡るようにと書いてあった。遥は水筒を鞄に入れ、町の小さなパン屋で朝食を買った。店主は窓から空を見上げて、今日は遠くまで見えるだろうと言った。石畳を歩く足音が静かな通りに響いた。岬の向こうで何が待っているのか、彼女はまだ知らなかった。\n",
        _ => unreachable!("profile was validated before building its corpus"),
    };
    let mut output = String::with_capacity(min_bytes + seed.len());
    let mut section = 1;
    while output.len() < min_bytes {
        if profile == "code_python" {
            output.push_str(&format!("\n# workload section {section:06}\n"));
        } else if profile == "code_mixed" {
            output.push_str(&format!("\n// workload section {section:06}\n"));
        } else {
            output.push_str(&format!("\n[{section:06}]\n"));
        }
        output.push_str(seed);
        section += 1;
    }
    output
}
