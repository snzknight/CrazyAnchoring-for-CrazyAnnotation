// ==UserScript==
// @name         狂插-作业拉框插入器 by snzknight
// @namespace    http://tampermonkey.net/
// @version      1.7
// @description  按Shift+Z在鼠标位置弹出序号输入面板，点击按钮输入序号到输入框（修复受控输入框失焦回滚）
// @author       snzknight
// @match        https://annot.aminer.cn/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    /** -------------------------
     *  Debug 开关：出问题时改 true
     *  ------------------------- */
    const DEBUG = false;
    const log = (...args) => DEBUG && console.log('[SEQ]', ...args);

    let sequencePanel = null;
    let activeInput = null;
    let isPanelVisible = false;
    let mouseX = 0;
    let mouseY = 0;

    function trackActiveInput() {
        document.addEventListener('focusin', function(e) {
            if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) {
                activeInput = e.target;
                log('focusin activeInput =', activeInput);
            }
        });

        // 监测 blur 时 value 是否回滚（用于定位）
        document.addEventListener('focusout', function(e) {
            if (!DEBUG) return;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
                log('focusout value =', t.value);
            } else if (t && t.isContentEditable) {
                log('focusout textContent =', t.textContent);
            }
        });

        document.addEventListener('mousedown', function(e) {
            if (sequencePanel && sequencePanel.contains(e.target)) {
                e.preventDefault();
                e.stopPropagation();
                if (activeInput && activeInput.focus) {
                    setTimeout(() => activeInput.focus(), 10);
                }
            }
        });
    }

    /** -------------------------
     *  核心修复：原生 setter + React tracker + InputEvent
     *  ------------------------- */
    function setNativeValueAndDispatch(el, newValue, insertedText) {
        const isTextArea = el.tagName === 'TEXTAREA';
        const proto = isTextArea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;

        const lastValue = el.value; // 重要：先记录旧值
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        const setter = desc && desc.set;

        if (setter) {
            setter.call(el, newValue);
        } else {
            el.value = newValue;
        }

        // React 受控输入框：把 tracker 的“旧值”设置回去，React 才会认为“值发生了变化”
        const tracker = el._valueTracker;
        if (tracker) {
            tracker.setValue(lastValue);
            log('react tracker found, lastValue=', lastValue, 'newValue=', newValue);
        } else {
            log('no react tracker, lastValue=', lastValue, 'newValue=', newValue);
        }

        // beforeinput（有些编辑器/框架会监听）
        try {
            const be = new InputEvent('beforeinput', {
                bubbles: true,
                cancelable: true,
                data: insertedText,
                inputType: 'insertText'
            });
            el.dispatchEvent(be);
            log('dispatched beforeinput, defaultPrevented=', be.defaultPrevented);
        } catch (err) {
            log('beforeinput not supported:', err);
        }

        // input（关键：通知框架更新 state）
        try {
            const ie = new InputEvent('input', {
                bubbles: true,
                cancelable: false,
                data: insertedText,
                inputType: 'insertText'
            });
            el.dispatchEvent(ie);
            log('dispatched InputEvent(input)');
        } catch (err) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            log('dispatched Event(input) fallback');
        }

        // change（部分站点在 change 上做校验）
        el.dispatchEvent(new Event('change', { bubbles: true }));
        log('dispatched change');
    }

    function insertIntoInputOrTextarea(el, text) {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        const value = el.value ?? '';

        const newValue = value.substring(0, start) + text + value.substring(end);

        setNativeValueAndDispatch(el, newValue, text);

        // 光标位置
        const pos = start + text.length;
        try {
            el.setSelectionRange(pos, pos);
        } catch (_) {}
    }

    function insertIntoContentEditable(el, text) {
        // 优先 execCommand（很多富文本/编辑器兼容更好）
        el.focus();
        const ok = document.execCommand && document.execCommand('insertText', false, text);
        log('execCommand insertText ok=', ok);

        // fallback：Range 插入
        if (!ok) {
            const selection = window.getSelection();
            if (selection && selection.rangeCount > 0) {
                const range = selection.getRangeAt(0);
                range.deleteContents();
                const textNode = document.createTextNode(text);
                range.insertNode(textNode);

                const newRange = document.createRange();
                newRange.setStartAfter(textNode);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);
            } else {
                el.textContent += text;
            }
        }

        // 通知输入变化
        try {
            const ie = new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' });
            el.dispatchEvent(ie);
            log('contenteditable dispatched InputEvent(input)');
        } catch {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            log('contenteditable dispatched Event(input)');
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // 插入序号到输入框
    function insertSequence(seq) {
        if (!activeInput) {
            console.log('没有活动的输入框');
            showMessage('请先点击一个输入框', 2000);
            return;
        }

        try {
            if (activeInput.isContentEditable) {
                insertIntoContentEditable(activeInput, seq);
            } else {
                insertIntoInputOrTextarea(activeInput, seq);
            }

            log('inserted seq=', seq, 'finalValue=', activeInput.isContentEditable ? activeInput.textContent : activeInput.value);
            showMessage(`已插入: ${seq}`, 1500);

            // 重新聚焦（避免面板点击导致焦点跳走）
            setTimeout(() => activeInput && activeInput.focus && activeInput.focus(), 0);
        } catch (error) {
            console.error('插入序号失败:', error);
            showMessage('插入失败，请尝试其他方法', 2000);
        }
    }

    // 创建序号输入面板
    function createSequencePanel() {
        if (sequencePanel) {
            if (sequencePanel.style.display === 'none') showPanel();
            else hidePanel();
            return;
        }

        sequencePanel = document.createElement('div');
        sequencePanel.id = 'sequenceInputPanel';
        sequencePanel.style.cssText = `
            position: fixed;
            left: ${mouseX}px;
            top: ${mouseY}px;
            background: rgba(0, 0, 0, 0.8);
            color: white;
            border-radius: 8px;
            z-index: 10000;
            font-family: Arial, sans-serif;
            font-size: 14px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.4);
            border: 1px solid rgba(255, 255, 255, 0.2);
            user-select: none;
            overflow: hidden;
            min-width: 300px;
            max-width: 400px;
            transition: all 0.3s ease;
            opacity: 0;
            transform: scale(0.9);
        `;

        const header = document.createElement('div');
        header.style.cssText = `
            background: rgba(24, 144, 255, 0.8);
            color: white;
            padding: 8px 15px;
            border-radius: 8px 8px 0 0;
            font-weight: bold;
            cursor: move;
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;
        header.innerHTML = `
            <span>狂插-作业拉框序号插入器 by snzknight</span>
            <span style="font-size:12px; opacity:0.8; cursor:pointer;" id="closePanelBtn">×</span>
        `;

        const content = document.createElement('div');
        content.style.cssText = `
            padding: 15px;
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(60px, 1fr));
            gap: 8px;
            max-height: 300px;
            overflow-y: auto;
        `;

        const sequences = [
            '（1）','（2）','（3）','（4）','（5）','（6）','（7）','（8）','（9）','（10）',
            '①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩','I','i',
            '空1','空2','空3','空4','空5','空6','空7','空8','空9','空10',
        ];

        sequences.forEach(seq => {
            const button = document.createElement('button');
            button.textContent = seq;
            button.style.cssText = `
                padding: 8px 5px;
                background: rgba(255, 255, 255, 0.1);
                color: white;
                border: 1px solid rgba(255, 255, 255, 0.2);
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
                transition: all 0.2s;
                min-height: 40px;
            `;
            button.addEventListener('mouseenter', () => {
                button.style.background = 'rgba(24, 144, 255, 0.5)';
                button.style.transform = 'translateY(-1px)';
            });
            button.addEventListener('mouseleave', () => {
                button.style.background = 'rgba(255, 255, 255, 0.1)';
                button.style.transform = 'translateY(0)';
            });
            button.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
            button.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                insertSequence(seq);
            });
            content.appendChild(button);
        });

        const customRow = document.createElement('div');
        customRow.style.cssText = `
            grid-column: 1 / -1;
            display: flex;
            gap: 5px;
            margin-top: 10px;
        `;

        const customInput = document.createElement('input');
        customInput.type = 'text';
        customInput.placeholder = '输入自定义序号...';
        customInput.style.cssText = `
            flex: 1;
            padding: 8px;
            background: rgba(255, 255, 255, 0.1);
            color: white;
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 4px;
            font-size: 14px;
        `;

        const customButton = document.createElement('button');
        customButton.textContent = '插入';
        customButton.style.cssText = `
            padding: 8px 15px;
            background: rgba(24, 144, 255, 0.7);
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        `;
        customButton.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        customButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (customInput.value.trim()) {
                insertSequence(customInput.value.trim());
                customInput.value = '';
            }
        });

        customRow.appendChild(customInput);
        customRow.appendChild(customButton);
        content.appendChild(customRow);

        sequencePanel.appendChild(header);
        sequencePanel.appendChild(content);
        document.body.appendChild(sequencePanel);

        const closeBtn = header.querySelector('#closePanelBtn');
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            hidePanel();
        });

        // 拖拽
        let isDragging = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let panelStartX = 0;
        let panelStartY = 0;

        header.addEventListener('mousedown', (e) => {
            if (e.target.id === 'closePanelBtn') return;
            isDragging = true;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            const rect = sequencePanel.getBoundingClientRect();
            panelStartX = rect.left;
            panelStartY = rect.top;
            sequencePanel.style.transition = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            e.preventDefault();
            const deltaX = e.clientX - dragStartX;
            const deltaY = e.clientY - dragStartY;
            sequencePanel.style.left = (panelStartX + deltaX) + 'px';
            sequencePanel.style.top = (panelStartY + deltaY) + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                sequencePanel.style.transition = 'all 0.3s ease';
            }
        });

        setTimeout(() => {
            sequencePanel.style.opacity = '1';
            sequencePanel.style.transform = 'scale(1)';
        }, 10);

        isPanelVisible = true;
        log('panel created');
    }

    function showPanel() {
        if (!sequencePanel) return;
        sequencePanel.style.display = 'block';
        sequencePanel.style.opacity = '0';
        sequencePanel.style.transform = 'scale(0.9)';
        setTimeout(() => {
            sequencePanel.style.opacity = '1';
            sequencePanel.style.transform = 'scale(1)';
        }, 10);
        isPanelVisible = true;
    }

    function hidePanel() {
        if (!sequencePanel) return;
        sequencePanel.style.opacity = '0';
        sequencePanel.style.transform = 'scale(0.9)';
        setTimeout(() => {
            if (sequencePanel) sequencePanel.style.display = 'none';
        }, 300);
        isPanelVisible = false;
    }

    function showMessage(text, duration = 2000) {
        const existingMsg = document.getElementById('sequenceInputMessage');
        if (existingMsg) existingMsg.remove();

        const message = document.createElement('div');
        message.id = 'sequenceInputMessage';
        message.textContent = text;
        message.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 10px 15px;
            border-radius: 4px;
            z-index: 10001;
            font-family: Arial, sans-serif;
            font-size: 14px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
            transition: all 0.3s ease;
            opacity: 0;
            transform: translateY(-10px);
        `;
        document.body.appendChild(message);

        setTimeout(() => {
            message.style.opacity = '1';
            message.style.transform = 'translateY(0)';
        }, 10);

        setTimeout(() => {
            message.style.opacity = '0';
            message.style.transform = 'translateY(-10px)';
            setTimeout(() => message.remove(), 300);
        }, duration);
    }

    document.addEventListener('mousemove', (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
    });

    document.addEventListener('keydown', (e) => {
        if ((e.key === 'z' || e.key === 'Z' || e.keyCode === 90) && e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            createSequencePanel();
        }
        // ESC 关闭逻辑仍保持禁用
    });

    function init() {
        trackActiveInput();
        console.log('狂插-作业拉框序号插入器已加载 (版本1.7 修复版)');
        console.log('使用说明: 点击输入框 → Shift+Z 打开面板 → 点击按钮插入');
        if (DEBUG) console.log('DEBUG 已开启，将输出详细插入/事件日志');
        setTimeout(() => showMessage('按 Shift+Z 打开序号输入面板', 3000), 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
