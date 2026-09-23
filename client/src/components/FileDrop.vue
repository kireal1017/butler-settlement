<script setup>
import { ref, computed } from 'vue';

/**
 * 파일 하나를 고르는 영역 — 끌어다 놓거나, 영역을 눌러 고른다.
 *
 * 브라우저 기본 `<input type="file">` 은 '파일 선택' 버튼과 '선택된 파일 없음' 이라는
 * 회색 글자가 전부라, 어디에 무엇을 해야 하는지가 보이지 않는다. 등기부든 계약서든
 * 사용자가 들고 오는 것은 **사진 한 장**이므로, 그 한 장을 떨어뜨릴 자리를 먼저 보여 준다.
 *
 * 왜 파일을 여기서 한 번 걸러내는가 --------------------------------------
 * 서버 multer 의 `fileFilter` 는 이미지가 아니면 **조용히 버린다**(`cb(null, false)`).
 * 그러면 요청은 200/400 으로 돌아오는데 화면은 "파일을 올려 주세요" 만 말해서,
 * 사용자는 자기가 올린 PDF 가 왜 사라졌는지 알 수 없다. 여기서 먼저 말해 준다.
 *
 * 용량도 같다. 한도를 넘기면 multer 가 요청 자체를 끊어 네트워크 오류처럼 보인다.
 */
const props = defineProps({
  modelValue: { type: Object, default: null },   // File | null
  accept: { type: String, default: 'image/*' },
  /** 서버 multer 한도와 맞춘다 — 넘기면 요청이 끊겨 원인을 알 수 없게 된다 */
  maxBytes: { type: Number, default: 10 * 1024 * 1024 },
  disabled: { type: Boolean, default: false },
  label: { type: String, default: '사진을 여기에 끌어다 놓으세요' },
});
const emit = defineEmits(['update:modelValue']);

const input = ref(null);
const over = ref(false);
const error = ref('');

/**
 * 끌고 들어온 자식 요소마다 dragleave 가 튀어서, 카운터 없이 플래그만 쓰면
 * 영역 안에서 커서를 움직일 때 테두리가 깜빡인다.
 */
let depth = 0;

/** 1MB 미만은 KB 로 — 소수 한 자리로 반올림하면 작은 파일이 전부 '0MB' 가 된다 */
const size = (n) => (n < 1024 * 1024
  ? `${Math.max(1, Math.round(n / 1024))}KB`
  : `${Math.round((n / 1024 / 1024) * 10) / 10}MB`);
const sizeText = computed(() => (props.modelValue ? size(props.modelValue.size) : ''));

function accepts(file) {
  if (props.accept === 'image/*') return file.type.startsWith('image/');
  return props.accept.split(',').some((a) => {
    const t = a.trim();
    if (t.endsWith('/*')) return file.type.startsWith(t.slice(0, -1));
    if (t.startsWith('.')) return file.name.toLowerCase().endsWith(t.toLowerCase());
    return file.type === t;
  });
}

/** 여러 장을 떨어뜨려도 첫 장만 받는다 — 이 화면들은 전부 한 장짜리다 */
function take(fileList) {
  error.value = '';
  const file = fileList?.[0];
  if (!file) return;

  if (!accepts(file)) {
    error.value = `이미지 파일만 올릴 수 있습니다 — ${file.name}`;
    return;
  }
  if (file.size > props.maxBytes) {
    error.value = `파일이 너무 큽니다 (${size(file.size)}). ${size(props.maxBytes)} 이하로 올려 주세요.`;
    return;
  }
  emit('update:modelValue', file);
}

function onDrop(e) {
  depth = 0;
  over.value = false;
  if (props.disabled) return;
  take(e.dataTransfer?.files);
}

function onEnter() { if (!props.disabled) { depth += 1; over.value = true; } }
function onLeave() { depth -= 1; if (depth <= 0) { depth = 0; over.value = false; } }

function open() { if (!props.disabled) input.value?.click(); }

/** 같은 파일을 다시 고르면 change 가 안 뜬다 — 값을 비워 둔다 */
function onPick(e) {
  take(e.target.files);
  e.target.value = '';
}

function clear() {
  error.value = '';
  emit('update:modelValue', null);
}
</script>

<template>
  <div>
    <div
      class="drop"
      :class="{ over, filled: Boolean(modelValue), disabled }"
      role="button"
      :tabindex="disabled ? -1 : 0"
      :aria-disabled="disabled"
      @click="open"
      @keydown.enter.prevent="open"
      @keydown.space.prevent="open"
      @dragenter.prevent="onEnter"
      @dragover.prevent
      @dragleave.prevent="onLeave"
      @drop.prevent="onDrop"
    >
      <input ref="input" type="file" :accept="accept" :disabled="disabled" @change="onPick" />

      <template v-if="modelValue">
        <div class="picked">
          <strong class="name">{{ modelValue.name }}</strong>
          <span class="faint mono">{{ sizeText }}</span>
        </div>
        <div class="acts">
          <span class="faint">눌러서 다른 파일 고르기</span>
          <button class="btn btn-sm" @click.stop="clear">×</button>
        </div>
      </template>

      <template v-else>
        <p class="lead">{{ over ? '놓으면 올라갑니다' : label }}</p>
        <p class="faint">또는 <strong>눌러서 파일 고르기</strong></p>
      </template>
    </div>

    <p v-if="error" class="err">{{ error }}</p>
  </div>
</template>

<style scoped>
/* 그림자를 쓰지 않는다 (DESIGN-clay.md). 깊이는 크림 바닥과 테두리 대비로 만든다. */
.drop {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: var(--sp-xxs);
  min-height: 132px; padding: var(--sp-lg);
  border: 1.5px dashed var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-2);
  cursor: pointer;
  text-align: center;
  transition: background .12s ease, border-color .12s ease;
}
.drop:hover:not(.disabled) { border-color: var(--text-faint); }
.drop:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* 끌어다 놓는 중 — 근검정 테두리로 "여기가 받는 자리"를 분명히 한다.
   배경은 --surface-3(강조 밴드). --accent-soft 는 값이 --surface-2 와 같아
   평상시 배경과 구분되지 않는다 — 아무것도 안 바뀌는 규칙을 두지 않는다. */
.drop.over {
  border-color: var(--accent);
  border-style: solid;
  background: var(--surface-3);
}

.drop.filled {
  border-style: solid;
  border-color: var(--border);
  background: var(--canvas);
  min-height: 0; padding: 14px var(--sp-lg);
  flex-direction: row; justify-content: space-between; gap: var(--sp-md);
  text-align: left;
}

.drop.disabled { cursor: not-allowed; opacity: .6; }

.drop input[type="file"] { display: none; }

.lead { margin: 0; font-size: 15px; font-weight: 500; color: var(--text); }
.drop .faint { font-size: 13px; }

.picked { display: flex; align-items: baseline; gap: var(--sp-sm); min-width: 0; }
.picked .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.acts { display: flex; align-items: center; gap: var(--sp-sm); flex: none; }

.err {
  margin: var(--sp-sm) 0 0; font-size: 14px; color: var(--brand-coral);
}
</style>
