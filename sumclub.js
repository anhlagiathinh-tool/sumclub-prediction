import fastify from "fastify";
import cors from "@fastify/cors";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";

// --- CẤU HÌNH ---
const PORT = 3000;
const API_URL = "https://taixiu1.gsum01.com/api/luckydice1/GetSoiCau";

// --- GLOBAL STATE ---
let txHistory = [];
let currentSessionId = null;
let fetchInterval = null;
let stats = {
  total_predictions: 0,
  total_wins: 0,
  total_losses: 0,
  algorithm_performance: {}
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- MẪU CẦU NÂNG CAO ---
const PATTERN_DATABASE = {
  // Cầu cơ bản
  '1-1': { patterns: ['tx', 'xt'], action: 'break', confidence: 0.75 },
  'bệt_2': { patterns: ['tt', 'xx'], action: 'follow', confidence: 0.65 },
  'bệt_3': { patterns: ['ttt', 'xxx'], action: 'follow', confidence: 0.70 },
  'bệt_4+': { patterns: ['tttt', 'xxxx'], action: 'break', confidence: 0.80 },
  '2-2': { patterns: ['ttxx', 'xxtt'], action: 'break', confidence: 0.72 },
  '3-3': { patterns: ['tttxxx', 'xxxttt'], action: 'follow', confidence: 0.68 },
  
  // Cầu phức tạp
  '1-2-1': { patterns: ['txxxt', 'xtttx'], action: 'break', confidence: 0.78 },
  '2-1-2': { patterns: ['ttxtt', 'xxtxx'], action: 'follow', confidence: 0.70 },
  '1-2-3': { patterns: ['txxttt', 'xttxxx'], action: 'break', confidence: 0.73 },
  '3-2-3': { patterns: ['tttxttt', 'xxxtxxx'], action: 'follow', confidence: 0.71 },
  
  // Cầu xen kẽ
  'zigzag_3': { patterns: ['txt', 'xtx'], action: 'follow', confidence: 0.67 },
  'zigzag_5': { patterns: ['txtxt', 'xtxtx'], action: 'follow', confidence: 0.69 },
  'zigzag_7': { patterns: ['txtxtxt', 'xtxtxtx'], action: 'break', confidence: 0.76 },
  
  // Cầu chu kỳ dài
  '1-1-1-2': { patterns: ['txttx', 'xtxxt'], action: 'break', confidence: 0.74 },
  '2-1-1-1': { patterns: ['ttxtx', 'xxtxt'], action: 'follow', confidence: 0.66 },
  
  // Cầu hình học
  'triangle': { patterns: ['txx', 'xtt'], action: 'break', confidence: 0.72 },
  'square': { patterns: ['ttxx', 'xxtt'], action: 'follow', confidence: 0.68 },
  'pentagon': { patterns: ['tttxx', 'xxxtt'], action: 'break', confidence: 0.75 },
  
  // Cầu sóng
  'wave_2': { patterns: ['ttxx', 'xxtt'], action: 'follow', confidence: 0.70 },
  'wave_3': { patterns: ['tttxxx', 'xxxttt'], action: 'break', confidence: 0.77 },
  
  // Cầu đảo chiều
  'reverse_2': { patterns: ['ttxx', 'xxtt'], action: 'break', confidence: 0.79 },
  'reverse_3': { patterns: ['tttxxx', 'xxxttt'], action: 'follow', confidence: 0.73 },
  
  // Cầu đối xứng
  'symmetry_2': { patterns: ['ttxxtt', 'xxttxx'], action: 'follow', confidence: 0.71 },
  'symmetry_3': { patterns: ['tttxxxttt', 'xxxxttxxx'], action: 'break', confidence: 0.82 },
  
  // Cầu lặp
  'repeat_4': { patterns: ['tttt', 'xxxx'], action: 'break', confidence: 0.85 },
  'repeat_5+': { patterns: ['ttttt', 'xxxxx'], action: 'break', confidence: 0.88 },
  
  // Cầu Fibonacci
  'fibonacci_3': { patterns: ['txt', 'xtx'], action: 'follow', confidence: 0.69 },
  'fibonacci_5': { patterns: ['txttx', 'xtxxt'], action: 'break', confidence: 0.76 }
};

// --- UTILITIES TỐI ƯU ---
function parseLines(data) {
  if (!data || !Array.isArray(data)) return [];
  
  return data
    .sort((a, b) => b.SessionId - a.SessionId)
    .map(item => {
      const total = item.DiceSum;
      const txLabel = total >= 11 ? 'T' : 'X';
      let result = "TAI";
      
      if (item.BetSide === 1) {
        result = "XIU";
      } else if (item.BetSide !== 0) {
        result = txLabel === 'T' ? "TAI" : "XIU";
      }

      return {
        session: item.SessionId,
        dice: [item.FirstDice, item.SecondDice, item.ThirdDice],
        total: total,
        result: result,
        tx: txLabel
      };
    })
    .sort((a, b) => a.session - b.session);
}

function analyzeSequence(sequence) {
  if (!sequence || sequence.length < 2) return { patterns: [], dominant: null };
  
  const patterns = [];
  const seqStr = sequence.join('');
  
  // Quét tất cả mẫu trong database
  for (const [name, data] of Object.entries(PATTERN_DATABASE)) {
    for (const pattern of data.patterns) {
      if (seqStr.includes(pattern) && pattern.length >= 3) {
        patterns.push({
          name,
          pattern,
          action: data.action,
          confidence: data.confidence,
          position: seqStr.lastIndexOf(pattern)
        });
      }
    }
  }
  
  // Sắp xếp theo độ dài và vị trí
  patterns.sort((a, b) => {
    if (b.pattern.length !== a.pattern.length) {
      return b.pattern.length - a.pattern.length;
    }
    return b.position - a.position;
  });
  
  return { 
    patterns: patterns.slice(0, 3), // Lấy 3 mẫu tốt nhất
    dominant: patterns.length > 0 ? patterns[0] : null
  };
}

// --- CORE ALGORITHMS TỐI ƯU (12 THUẬT TOÁN) ---

// 1. AI NHẬN DIỆN MẪU CẦU THÔNG MINH
function algo1_pattern_master(history) {
  if (history.length < 10) return null;
  
  const txSequence = history.slice(-20).map(h => h.tx);
  const { patterns, dominant } = analyzeSequence(txSequence);
  
  if (!dominant) return null;
  
  const lastTx = txSequence[txSequence.length - 1];
  const lastRun = extractRuns(txSequence).at(-1);
  
  // Áp dụng chiến lược dựa trên mẫu
  if (dominant.action === 'follow') {
    // Theo cầu thông minh - phân tích độ dài cầu
    if (dominant.name.includes('bệt')) {
      if (lastRun && lastRun.len >= 4) {
        return lastTx === 'T' ? 'X' : 'T'; // Bẻ cầu bệt dài
      }
      return lastTx; // Theo cầu bệt ngắn
    }
    return lastTx;
  } else if (dominant.action === 'break') {
    // Bẻ cầu thông minh - phân tích điểm đảo chiều
    return lastTx === 'T' ? 'X' : 'T';
  }
  
  return null;
}

// 2. AI THÍCH NGHI CẦU ĐỘNG
function algo2_adaptive_dynamic(history) {
  if (history.length < 15) return null;
  
  const tx = history.map(h => h.tx);
  const recent = tx.slice(-15);
  
  // Tính toán động lực học
  const momentum = calculateMomentum(recent);
  const volatility = calculateVolatility(recent);
  
  // Phân tích thích nghi
  if (volatility < 0.3 && Math.abs(momentum) > 0.6) {
    // Xu hướng mạnh, ổn định -> theo trend
    return momentum > 0 ? 'T' : 'X';
  } else if (volatility > 0.7) {
    // Biến động cao -> đảo chiều
    return recent[recent.length - 1] === 'T' ? 'X' : 'T';
  }
  
  // Phân tích cân bằng tần suất động
  const freqT = recent.filter(x => x === 'T').length;
  const freqX = recent.filter(x => x === 'X').length;
  
  if (Math.abs(freqT - freqX) > 5) {
    return freqT > freqX ? 'X' : 'T';
  }
  
  return null;
}

// 3. AI PHÂN TÍCH SÂU NEURAL
function algo3_neural_deep(history) {
  if (history.length < 40) return null;
  
  const features = extractAdvancedFeatures(history);
  
  // Neural network simulation
  let scoreT = 0;
  let scoreX = 0;
  
  // Feature 1: Trend analysis
  if (features.trendStrength > 0.7) {
    scoreT += features.trendDirection === 'up' ? 1.2 : -0.3;
    scoreX += features.trendDirection === 'down' ? 1.2 : -0.3;
  }
  
  // Feature 2: Mean reversion
  if (features.meanReversionSignal) {
    scoreT += features.currentMean > 11 ? -1.0 : 0.8;
    scoreX += features.currentMean < 9 ? -1.0 : 0.8;
  }
  
  // Feature 3: Pattern consistency
  if (features.patternConsistency > 0.6) {
    scoreT += features.lastPattern === 'T' ? 0.9 : -0.4;
    scoreX += features.lastPattern === 'X' ? 0.9 : -0.4;
  }
  
  // Feature 4: Volatility prediction
  if (features.volatility < 0.4) {
    scoreT += features.lastTx === 'T' ? 0.7 : -0.2;
    scoreX += features.lastTx === 'X' ? 0.7 : -0.2;
  } else {
    scoreT += features.lastTx === 'T' ? -0.5 : 0.6;
    scoreX += features.lastTx === 'X' ? -0.5 : 0.6;
  }
  
  if (Math.abs(scoreT - scoreX) > 0.8) {
    return scoreT > scoreX ? 'T' : 'X';
  }
  
  return null;
}

// 4. AI THEO CẦU THÔNG MINH
function algo4_smart_follow(history) {
  if (history.length < 8) return null;
  
  const runs = extractRuns(history.map(h => h.tx));
  if (runs.length < 2) return null;
  
  const currentRun = runs[runs.length - 1];
  const prevRun = runs[runs.length - 2];
  
  // Chiến lược theo cầu thông minh
  if (currentRun.len === 1) {
    // Mới bắt đầu cầu -> chờ thêm
    return null;
  } else if (currentRun.len === 2) {
    // Cầu ngắn 2 -> có thể theo nếu trước đó không phải cùng loại
    if (prevRun && prevRun.val !== currentRun.val && prevRun.len <= 2) {
      return currentRun.val;
    }
  } else if (currentRun.len === 3) {
    // Cầu 3 -> mạnh, nên theo
    return currentRun.val;
  } else if (currentRun.len === 4) {
    // Cầu 4 -> cân nhắc, 50% theo
    return Math.random() > 0.5 ? currentRun.val : null;
  } else if (currentRun.len >= 5) {
    // Cầu dài 5+ -> không theo nữa
    return currentRun.val === 'T' ? 'X' : 'T';
  }
  
  return null;
}

// 5. AI BẺ CẦU THÔNG MINH
function algo5_smart_break(history) {
  if (history.length < 12) return null;
  
  const runs = extractRuns(history.map(h => h.tx));
  if (runs.length < 3) return null;
  
  const currentRun = runs[runs.length - 1];
  const prevRuns = runs.slice(-4, -1);
  
  // Điều kiện bẻ cầu thông minh
  const breakConditions = [];
  
  // 1. Cầu bệt quá dài (>=5)
  if (currentRun.len >= 5) {
    breakConditions.push({ condition: 'long_streak', confidence: 0.85 });
  }
  
  // 2. Chuỗi các cầu ngắn lặp lại
  if (prevRuns.length >= 3 && prevRuns.every(r => r.len >= 2 && r.len <= 3)) {
    breakConditions.push({ condition: 'short_sequence', confidence: 0.75 });
  }
  
  // 3. Mẫu đối xứng hoàn chỉnh
  const sequence = history.slice(-8).map(h => h.tx).join('');
  if (sequence.length >= 6) {
    const firstHalf = sequence.slice(0, 3);
    const secondHalf = sequence.slice(3, 6);
    const reversed = firstHalf.split('').map(c => c === 'T' ? 'X' : 'T').join('');
    if (secondHalf === reversed) {
      breakConditions.push({ condition: 'symmetry', confidence: 0.82 });
    }
  }
  
  // 4. Phân tích momentum đảo chiều
  const momentum = calculateMomentum(history.slice(-10).map(h => h.tx));
  if (Math.abs(momentum) > 0.8) {
    breakConditions.push({ condition: 'momentum_reversal', confidence: 0.78 });
  }
  
  if (breakConditions.length > 0) {
    // Tính confidence trung bình
    const avgConfidence = breakConditions.reduce((sum, c) => sum + c.confidence, 0) / breakConditions.length;
    if (avgConfidence > 0.7) {
      return currentRun.val === 'T' ? 'X' : 'T';
    }
  }
  
  return null;
}

// 6. AI MARKOV NÂNG CAO
function algo6_advanced_markov(history) {
  const tx = history.map(h => h.tx);
  if (tx.length < 30) return null;
  
  const orders = [2, 3, 4];
  let bestPrediction = null;
  let bestConfidence = 0;
  
  for (const order of orders) {
    if (tx.length < order + 10) continue;
    
    // Xây dựng mô hình Markov
    const model = buildMarkovModel(tx, order);
    const currentState = tx.slice(-order).join('');
    
    if (model[currentState]) {
      const total = model[currentState].T + model[currentState].X;
      if (total >= 3) { // Cần ít nhất 3 lần xuất hiện
        const probT = model[currentState].T / total;
        const probX = model[currentState].X / total;
        
        const confidence = Math.abs(probT - probX);
        if (confidence > bestConfidence && confidence > 0.25) {
          bestConfidence = confidence;
          bestPrediction = probT > probX ? 'T' : 'X';
        }
      }
    }
  }
  
  return bestPrediction;
}

// 7. AI TRANSFORMER TỐI ƯU
function algo7_optimized_transformer(history) {
  const tx = history.map(h => h.tx);
  if (tx.length < 60) return null;
  
  const contextLength = 8;
  const targetSequence = tx.slice(-contextLength).join('');
  
  let weightedPredictions = { T: 0, X: 0 };
  let totalWeight = 0;
  
  // Tìm các sequence tương tự trong lịch sử
  for (let i = 0; i <= tx.length - contextLength - 1; i++) {
    const historicalSeq = tx.slice(i, i + contextLength).join('');
    const similarity = calculateSequenceSimilarity(historicalSeq, targetSequence);
    
    if (similarity > 0.75) {
      const nextOutcome = tx[i + contextLength];
      // Trọng số theo similarity và recency
      const weight = similarity * Math.exp(-(tx.length - i) / 80);
      weightedPredictions[nextOutcome] += weight;
      totalWeight += weight;
    }
  }
  
  if (totalWeight > 0.3) {
    const confidence = Math.abs(weightedPredictions.T - weightedPredictions.X) / totalWeight;
    if (confidence > 0.15) {
      return weightedPredictions.T > weightedPredictions.X ? 'T' : 'X';
    }
  }
  
  return null;
}

// 8. AI PHÂN TÍCH CHU KỲ
function algo8_cycle_analysis(history) {
  if (history.length < 50) return null;
  
  const tx = history.map(h => h.tx);
  const cycles = detectCycles(tx);
  
  if (cycles.dominantCycle && cycles.confidence > 0.65) {
    const cycleLength = cycles.dominantCycle;
    const position = tx.length % cycleLength;
    
    // Dự đoán dựa trên vị trí trong chu kỳ
    if (cycles.pattern && cycles.pattern[position]) {
      return cycles.pattern[position];
    }
  }
  
  return null;
}

// 9. AI CÂN BẰNG XÁC SUẤT
function algo9_probability_balance(history) {
  const tx = history.map(h => h.tx);
  if (tx.length < 20) return null;
  
  const recent = tx.slice(-20);
  const totals = history.slice(-20).map(h => h.total);
  
  // Phân tích đa chiều
  const tCount = recent.filter(x => x === 'T').length;
  const xCount = recent.filter(x => x === 'X').length;
  const avgTotal = totals.reduce((a, b) => a + b, 0) / totals.length;
  
  // Quy tắc cân bằng thông minh
  if (tCount > xCount + 3 && avgTotal > 11) {
    return 'X'; // Tài nhiều, tổng cao -> về Xỉu
  } else if (xCount > tCount + 3 && avgTotal < 9) {
    return 'T'; // Xỉu nhiều, tổng thấp -> về Tài
  } else if (Math.abs(tCount - xCount) > 4) {
    return tCount > xCount ? 'X' : 'T'; // Cân bằng tần suất
  }
  
  // Phân tích điểm hòa
  const middleZone = totals.filter(t => t >= 9 && t <= 12).length;
  if (middleZone / totals.length > 0.7) {
    // Nhiều điểm ở vùng giữa -> khó dự đoán
    return null;
  }
  
  return null;
}

// 10. AI HỌC SÂU (DEEP LEARNING)
function algo10_deep_learner(history) {
  if (history.length < 100) return null;
  
  const features = extractMultiDimensionalFeatures(history);
  
  // Mô phỏng mạng neural đơn giản
  const weights = {
    trend: 0.4,
    pattern: 0.3,
    momentum: 0.2,
    volume: 0.1
  };
  
  let tScore = 0;
  let xScore = 0;
  
  // Tính điểm dựa trên features
  if (features.strongTrend) {
    tScore += features.trendDirection === 'T' ? weights.trend : -weights.trend;
    xScore += features.trendDirection === 'X' ? weights.trend : -weights.trend;
  }
  
  if (features.detectedPattern) {
    tScore += features.patternSuggests === 'T' ? weights.pattern : -weights.pattern;
    xScore += features.patternSuggests === 'X' ? weights.pattern : -weights.pattern;
  }
  
  if (features.momentumStrength > 0.6) {
    tScore += features.momentumDirection === 'T' ? weights.momentum : -weights.momentum;
    xScore += features.momentumDirection === 'X' ? weights.momentum : -weights.momentum;
  }
  
  // Phân tích volume (số lượng phiên gần đây)
  if (features.recentVolume > 15) {
    tScore += features.volumeBias === 'T' ? weights.volume : 0;
    xScore += features.volumeBias === 'X' ? weights.volume : 0;
  }
  
  const diff = Math.abs(tScore - xScore);
  if (diff > 0.25) {
    return tScore > xScore ? 'T' : 'X';
  }
  
  return null;
}

// 11. AI DỰ ĐOÁN THEO XU HƯỚNG THỜI GIAN THỰC
function algo11_realtime_trend(history) {
  if (history.length < 25) return null;
  
  const segments = [
    history.slice(-25, -15),
    history.slice(-15, -5),
    history.slice(-5)
  ];
  
  const trends = segments.map(seg => {
    const tx = seg.map(h => h.tx);
    return tx.filter(x => x === 'T').length - tx.filter(x => x === 'X').length;
  });
  
  // Phân tích xu hướng 3 giai đoạn
  const trendStrength = Math.abs(trends[2]); // Xu hướng hiện tại
  const trendAcceleration = trends[2] - trends[1]; // Gia tốc xu hướng
  
  if (trendStrength >= 3) {
    if (trendAcceleration > 1) {
      // Xu hướng đang tăng tốc -> tiếp tục
      return trends[2] > 0 ? 'T' : 'X';
    } else if (trendAcceleration < -1) {
      // Xu hướng đang chậm lại -> chuẩn bị đảo chiều
      return trends[2] > 0 ? 'X' : 'T';
    } else {
      // Xu hướng ổn định
      return trends[2] > 0 ? 'T' : 'X';
    }
  }
  
  return null;
}

// 12. AI TỔNG HỢP ĐA CHIỀU
function algo12_multi_dimensional(history) {
  if (history.length < 35) return null;
  
  // Thu thập dự đoán từ các thuật toán con
  const subPredictions = [];
  
  // 1. Phân tích pattern
  const patternResult = algo1_pattern_master(history);
  if (patternResult) subPredictions.push({ source: 'pattern', value: patternResult, weight: 1.5 });
  
  // 2. Phân tích Markov
  const markovResult = algo6_advanced_markov(history);
  if (markovResult) subPredictions.push({ source: 'markov', value: markovResult, weight: 1.3 });
  
  // 3. Phân tích chu kỳ
  const cycleResult = algo8_cycle_analysis(history);
  if (cycleResult) subPredictions.push({ source: 'cycle', value: cycleResult, weight: 1.2 });
  
  if (subPredictions.length === 0) return null;
  
  // Tính toán weighted vote
  const votes = { T: 0, X: 0 };
  subPredictions.forEach(p => {
    votes[p.value] += p.weight;
  });
  
  if (votes.T !== votes.X) {
    return votes.T > votes.X ? 'T' : 'X';
  }
  
  return null;
}

// --- HÀM HỖ TRỢ ---
function extractRuns(txArray) {
  const runs = [];
  if (txArray.length === 0) return runs;
  
  let current = txArray[0];
  let length = 1;
  
  for (let i = 1; i < txArray.length; i++) {
    if (txArray[i] === current) {
      length++;
    } else {
      runs.push({ val: current, len: length });
      current = txArray[i];
      length = 1;
    }
  }
  
  runs.push({ val: current, len: length });
  return runs;
}

function calculateMomentum(sequence) {
  if (sequence.length < 2) return 0;
  
  let changes = 0;
  for (let i = 1; i < sequence.length; i++) {
    if (sequence[i] === sequence[i - 1]) {
      changes += sequence[i] === 'T' ? 1 : -1;
    } else {
      changes += sequence[i] === 'T' ? 0.5 : -0.5;
    }
  }
  
  return changes / sequence.length;
}

function calculateVolatility(sequence) {
  if (sequence.length < 2) return 0;
  
  let changes = 0;
  for (let i = 1; i < sequence.length; i++) {
    if (sequence[i] !== sequence[i - 1]) {
      changes++;
    }
  }
  
  return changes / (sequence.length - 1);
}

function extractAdvancedFeatures(history) {
  const tx = history.map(h => h.tx);
  const totals = history.map(h => h.total);
  
  const recentTx = tx.slice(-10);
  const recentTotals = totals.slice(-10);
  
  return {
    trendStrength: calculateMomentum(recentTx),
    trendDirection: recentTx.filter(x => x === 'T').length > recentTx.length / 2 ? 'up' : 'down',
    meanReversionSignal: Math.abs(avg(recentTotals) - 10.5) > 1.5,
    currentMean: avg(recentTotals),
    patternConsistency: 1 - calculateVolatility(recentTx),
    lastPattern: recentTx[recentTx.length - 1],
    volatility: calculateVolatility(recentTx),
    lastTx: recentTx[recentTx.length - 1]
  };
}

function buildMarkovModel(sequence, order) {
  const model = {};
  
  for (let i = 0; i <= sequence.length - order - 1; i++) {
    const state = sequence.slice(i, i + order).join('');
    const next = sequence[i + order];
    
    if (!model[state]) {
      model[state] = { T: 0, X: 0 };
    }
    
    model[state][next]++;
  }
  
  return model;
}

function calculateSequenceSimilarity(seq1, seq2) {
  if (seq1.length !== seq2.length) return 0;
  
  let matches = 0;
  for (let i = 0; i < seq1.length; i++) {
    if (seq1[i] === seq2[i]) matches++;
  }
  
  return matches / seq1.length;
}

function detectCycles(sequence) {
  if (sequence.length < 20) return { dominantCycle: null, confidence: 0 };
  
  const maxCycleLength = Math.min(10, Math.floor(sequence.length / 2));
  let bestCycle = null;
  let bestConfidence = 0;
  
  for (let cycleLen = 2; cycleLen <= maxCycleLength; cycleLen++) {
    let matches = 0;
    let total = 0;
    
    for (let i = 0; i < sequence.length - cycleLen; i++) {
      if (sequence[i] === sequence[i + cycleLen]) {
        matches++;
      }
      total++;
    }
    
    const confidence = matches / total;
    if (confidence > bestConfidence && confidence > 0.6) {
      bestConfidence = confidence;
      bestCycle = cycleLen;
    }
  }
  
  return {
    dominantCycle: bestCycle,
    confidence: bestConfidence,
    pattern: bestCycle ? sequence.slice(-bestCycle) : null
  };
}

function extractMultiDimensionalFeatures(history) {
  const tx = history.map(h => h.tx);
  const recent = tx.slice(-15);
  
  return {
    strongTrend: Math.abs(calculateMomentum(recent)) > 0.5,
    trendDirection: calculateMomentum(recent) > 0 ? 'T' : 'X',
    detectedPattern: analyzeSequence(recent).dominant !== null,
    patternSuggests: analyzeSequence(recent).dominant?.action === 'follow' ? recent[recent.length - 1] : (recent[recent.length - 1] === 'T' ? 'X' : 'T'),
    momentumStrength: Math.abs(calculateMomentum(tx.slice(-8))),
    momentumDirection: calculateMomentum(tx.slice(-8)) > 0 ? 'T' : 'X',
    recentVolume: recent.length,
    volumeBias: recent.filter(x => x === 'T').length > recent.filter(x => x === 'X').length ? 'T' : 'X'
  };
}

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// --- DANH SÁCH THUẬT TOÁN HOÀN CHỈNH ---
const ALL_ALGORITHMS = [
  { id: 'pattern_master', fn: algo1_pattern_master, weight: 1.8 },
  { id: 'adaptive_dynamic', fn: algo2_adaptive_dynamic, weight: 1.5 },
  { id: 'neural_deep', fn: algo3_neural_deep, weight: 1.7 },
  { id: 'smart_follow', fn: algo4_smart_follow, weight: 1.4 },
  { id: 'smart_break', fn: algo5_smart_break, weight: 1.6 },
  { id: 'advanced_markov', fn: algo6_advanced_markov, weight: 1.5 },
  { id: 'optimized_transformer', fn: algo7_optimized_transformer, weight: 1.9 },
  { id: 'cycle_analysis', fn: algo8_cycle_analysis, weight: 1.3 },
  { id: 'probability_balance', fn: algo9_probability_balance, weight: 1.2 },
  { id: 'deep_learner', fn: algo10_deep_learner, weight: 1.8 },
  { id: 'realtime_trend', fn: algo11_realtime_trend, weight: 1.4 },
  { id: 'multi_dimensional', fn: algo12_multi_dimensional, weight: 2.0 }
];

// --- HỆ THỐNG ENSEMBLE TỐI ƯU ---
class UltraEnsemble {
  constructor(algorithms) {
    this.algorithms = algorithms;
    this.weights = {};
    this.performance = {};
    
    algorithms.forEach(alg => {
      this.weights[alg.id] = alg.weight;
      this.performance[alg.id] = { correct: 0, total: 0, recent: [] };
    });
    
    this.normalizeWeights();
  }
  
  normalizeWeights() {
    const total = Object.values(this.weights).reduce((a, b) => a + b, 0);
    for (const id in this.weights) {
      this.weights[id] /= total;
    }
  }
  
  updatePerformance(algorithmId, isCorrect) {
    const perf = this.performance[algorithmId];
    perf.total++;
    if (isCorrect) perf.correct++;
    
    // Lưu kết quả gần đây (tối đa 50)
    perf.recent.push(isCorrect ? 1 : 0);
    if (perf.recent.length > 50) {
      perf.recent.shift();
    }
    
    // Tính hiệu suất gần đây
    const recentPerf = perf.recent.length > 0 ? 
      perf.recent.reduce((a, b) => a + b, 0) / perf.recent.length : 0.5;
    
    // Điều chỉnh trọng số theo hiệu suất
    this.weights[algorithmId] = Math.max(0.1, Math.min(2.5, 
      this.weights[algorithmId] * (0.95 + recentPerf * 0.1)
    ));
    
    this.normalizeWeights();
  }
  
  predict(history) {
    const votes = { T: 0, X: 0 };
    const algorithmVotes = {};
    
    // Thu thập votes từ tất cả thuật toán
    this.algorithms.forEach(alg => {
      const prediction = alg.fn(history);
      if (prediction) {
        votes[prediction] += this.weights[alg.id];
        algorithmVotes[alg.id] = prediction;
      }
    });
    
    // Nếu không có prediction nào
    if (votes.T === 0 && votes.X === 0) {
      const fallback = algo9_probability_balance(history) || 'T';
      return {
        prediction: fallback === 'T' ? 'tài' : 'xỉu',
        confidence: 0.55,
        rawPrediction: fallback,
        algorithm: 'fallback'
      };
    }
    
    // Tính confidence
    const totalVotes = votes.T + votes.X;
    const winner = votes.T > votes.X ? 'T' : 'X';
    const confidence = Math.min(0.97, Math.max(0.55, 
      Math.max(votes.T, votes.X) / totalVotes
    ));
    
    // Xác định thuật toán nào đóng góp nhiều nhất
    let mainAlgorithm = 'ensemble';
    let maxContribution = 0;
    
    for (const [algId, vote] of Object.entries(algorithmVotes)) {
      if (vote === winner && this.weights[algId] > maxContribution) {
        maxContribution = this.weights[algId];
        mainAlgorithm = algId;
      }
    }
    
    return {
      prediction: winner === 'T' ? 'tài' : 'xỉu',
      confidence: confidence,
      rawPrediction: winner,
      algorithm: mainAlgorithm
    };
  }
  
  updateWithOutcome(historyPrefix, actualTx) {
    this.algorithms.forEach(alg => {
      const prediction = alg.fn(historyPrefix);
      if (prediction) {
        const isCorrect = prediction === actualTx;
        this.updatePerformance(alg.id, isCorrect);
      }
    });
  }
}

// --- MANAGER CLASS TỐI ƯU ---
class UltraManager {
  constructor() {
    this.history = [];
    this.ensemble = new UltraEnsemble(ALL_ALGORITHMS);
    this.currentPrediction = null;
    this.lastPredictionInfo = null;
  }
  
  loadInitial(lines) {
    this.history = lines;
    
    // Huấn luyện ban đầu trên lịch sử
    if (this.history.length >= 30) {
      for (let i = 15; i < this.history.length; i++) {
        const prefix = this.history.slice(0, i);
        const actualTx = this.history[i].tx;
        this.ensemble.updateWithOutcome(prefix, actualTx);
      }
    }
    
    this.currentPrediction = this.getPrediction();
  }
  
  pushRecord(record) {
    // Cập nhật thống kê
    if (this.lastPredictionInfo && this.lastPredictionInfo.session === record.session) {
      const isWin = this.lastPredictionInfo.prediction === record.tx;
      if (isWin) {
        stats.total_wins++;
      } else {
        stats.total_losses++;
      }
      stats.total_predictions++;
      
      // Cập nhật performance cho thuật toán được sử dụng
      if (this.lastPredictionInfo.algorithm && this.lastPredictionInfo.algorithm !== 'ensemble') {
        const algId = this.lastPredictionInfo.algorithm;
        if (!stats.algorithm_performance[algId]) {
          stats.algorithm_performance[algId] = { wins: 0, total: 0 };
        }
        stats.algorithm_performance[algId].total++;
        if (isWin) stats.algorithm_performance[algId].wins++;
      }
    }
    
    this.history.push(record);
    
    // Giữ lịch sử tối đa 300 phiên
    if (this.history.length > 300) {
      this.history = this.history.slice(-300);
    }
    
    // Cập nhật hiệu suất thuật toán
    const prefix = this.history.slice(0, -1);
    if (prefix.length >= 20) {
      this.ensemble.updateWithOutcome(prefix, record.tx);
    }
    
    // Tạo dự đoán mới
    this.currentPrediction = this.getPrediction();
    this.lastPredictionInfo = {
      session: record.session + 1,
      prediction: this.currentPrediction.rawPrediction,
      algorithm: this.currentPrediction.algorithm
    };
  }
  
  getPrediction() {
    return this.ensemble.predict(this.history);
  }
}

const manager = new UltraManager();

// --- API SERVER ---
const app = fastify({ logger: false });
await app.register(cors, { origin: "*" });

// Hàm lấy và xử lý dữ liệu
async function fetchAndProcessHistory() {
  try {
    const response = await fetch(API_URL);
    const data = await response.json();
    const newHistory = parseLines(data);
    
    if (newHistory.length === 0) return;
    
    const lastSession = newHistory.at(-1);
    
    if (!currentSessionId) {
      manager.loadInitial(newHistory);
      txHistory = newHistory;
      currentSessionId = lastSession.session;
    } else if (lastSession.session > currentSessionId) {
      const newRecords = newHistory.filter(r => r.session > currentSessionId);
      
      for (const record of newRecords) {
        manager.pushRecord(record);
        txHistory.push(record);
      }
      
      if (txHistory.length > 300) {
        txHistory = txHistory.slice(-300);
      }
      
      currentSessionId = lastSession.session;
    }
  } catch (e) {
    // Silent error handling
  }
}

// Khởi động
fetchAndProcessHistory();
clearInterval(fetchInterval);
fetchInterval = setInterval(fetchAndProcessHistory, 5000);

// --- ENDPOINTS ---

// 1. Endpoint dự đoán chính
app.get("/api/taixiumd5/sumclub/thinhtool", async () => {
  const lastResult = txHistory.at(-1);
  const currentPrediction = manager.currentPrediction;
  
  if (!lastResult || !currentPrediction) {
    return {
      id: "@thinhtool",
      phien_truoc: null,
      xuc_xac1: null,
      xuc_xac2: null,
      xuc_xac3: null,
      tong: null,
      ket_qua: null,
      phien_hien_tai: null,
      du_doan: null,
      do_tin_cay: "0%"
    };
  }
  
  return {
    id: "@thinhtool",
    phien_truoc: lastResult.session,
    xuc_xac1: lastResult.dice[0],
    xuc_xac2: lastResult.dice[1],
    xuc_xac3: lastResult.dice[2],
    tong: lastResult.total,
    ket_qua: lastResult.result.toLowerCase(),
    phien_hien_tai: lastResult.session + 1,
    du_doan: currentPrediction.prediction,
    do_tin_cay: `${(currentPrediction.confidence * 100).toFixed(0)}%`
  };
});

// 2. Endpoint lịch sử
app.get("/api/taixiumd5/history/thinhtool", async () => {
  if (!txHistory.length) {
    return { message: "không có dữ liệu lịch sử." };
  }
  
  const reversedHistory = [...txHistory].sort((a, b) => b.session - a.session);
  
  return reversedHistory.slice(0, 50).map((i) => ({
    session: i.session,
    dice: i.dice,
    total: i.total,
    result: i.result.toLowerCase(),
    tx_label: i.tx.toLowerCase()
  }));
});

// 3. Endpoint thống kê
app.get("/api/taixiumd5/sumclub/stats", async () => {
  const winRate = stats.total_predictions > 0 
    ? ((stats.total_wins / stats.total_predictions) * 100).toFixed(1)
    : "0.0";
  
  // Tính hiệu suất từng thuật toán
  const algorithmStats = {};
  for (const [algId, perf] of Object.entries(stats.algorithm_performance)) {
    if (perf.total > 0) {
      algorithmStats[algId] = {
        usage: perf.total,
        win_rate: `${((perf.wins / perf.total) * 100).toFixed(1)}%`
      };
    }
  }
    
  return {
    total_predictions: stats.total_predictions,
    total_wins: stats.total_wins,
    total_losses: stats.total_losses,
    win_rate: `${winRate}%`,
    algorithms_count: ALL_ALGORITHMS.length,
    history_size: txHistory.length,
    current_session: currentSessionId,
    algorithm_performance: algorithmStats
  };
});

// 4. Endpoint health check
app.get("/", async () => {
  return { status: "ok", server: "thinhtool ultra prediction engine" };
});

// --- SERVER START ---
const start = async () => {
  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`Server chạy thành công tại cổng ${PORT}`);
  } catch (err) {
    process.exit(1);
  }
};

start();