/* 在真实浏览器中运行的端到端测试（由 build-tests.py 注入到 index.html 副本）
 *
 * 用 async/await 写，因为密码走 PBKDF2 是异步的，事件之间也需要等待。
 * 结果写进 <pre id="TESTRESULT">，外层脚本轮询读取。
 */
(async function(){
  var out = [], pass = 0, fail = 0;
  function ok(name, cond, extra){
    if(cond){ pass++; out.push('PASS|' + name); }
    else { fail++; out.push('FAIL|' + name + '|' + (extra === undefined ? '' : extra)); }
  }
  function eq(name, a, b){ ok(name, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
  function $ (s){ return document.querySelector(s); }
  function $$(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); }
  function click(el){
    if(!el) throw new Error('要点击的元素不存在: ' + el);
    el.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true }));
  }
  function key(el, k){
    el.dispatchEvent(new KeyboardEvent('keydown', { key:k, bubbles:true, cancelable:true }));
  }
  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
  function store(){ return JSON.parse(localStorage.getItem('private-journal.v1')); }
  function pad(n){ return String(n).padStart(2,'0'); }
  function recs(){ return store().records[TK] || []; }
  function onChip(){ var c = $('.chip.on'); return c ? c.getAttribute('data-kind') : null; }
  function volShown(){ return $('#volField').classList.contains('show') && !$('#volField').classList.contains('hide'); }
  function onTags(){ return $$('#tagChips .tag.on').map(function(e){ return e.getAttribute('data-tag'); }); }
  function recByTime(t){ return recs().filter(function(r){ return r.t === t; })[0]; }

  var now = new Date();
  var TK = now.getFullYear() + '-' + pad(now.getMonth()+1) + '-' + pad(now.getDate());
  function pin(code){
    code.split('').forEach(function(ch){ click($('#keypad button[data-k="' + ch + '"]')); });
  }
  var D = window.__dyf;   // 应用暴露出来的调试入口

  try{
    /* ============ [1] 初始渲染 ============ */
    eq('日历 42 格', $$('#calGrid .cell').length, 42);
    eq('月份标题', $('#monthTitle').textContent, now.getFullYear() + '年' + (now.getMonth()+1) + '月');
    eq('星期表头 7 列', $$('#weekdays span').length, 7);
    eq('今天唯一标记', $$('#calGrid .cell.today').length, 1);
    eq('默认选中今天', $('#calGrid .cell.sel').dataset.key, TK);
    eq('空状态提示', $$('#recList .empty').length, 1);
    eq('柱状图 30 根', $$('#bars .b').length, 30);
    eq('热力图 26 列', $$('#heat .col').length, 26);
    eq('热力图 182 格', $$('#heat .hc').length, 182);
    eq('总览卡 4 张', $$('#bigStats .big').length, 4);
    eq('详细数据 11 行', $$('#detailRows .row').length, 11);
    eq('详细数据分 3 组', $$('#detailRows .rows-sub').length, 3);
    eq('类型分布空态', $$('#typeDist .empty').length, 1);
    eq('诱因分布空态', $$('#tagDist .empty').length, 1);
    eq('目标卡已渲染', !!$('#goalCard .goal-top'), true);
    eq('趋势图已渲染', $$('#trendWrap svg').length, 1);
    eq('趋势折线 1 条', $$('#trendWrap .ln').length, 1);
    eq('趋势点 12 个', $$('#trendWrap .pt').length, 12);

    /* ============ [2] 类型选项存在且齐全 ============ */
    eq('类型 chip 3 个', $$('#kindChips .chip').length, 3);
    eq('包含射精', $('#kindChips .chip[data-kind="ej"]').textContent.trim(), '射精');
    eq('包含流精', $('#kindChips .chip[data-kind="fl"]').textContent.trim(), '流精');
    eq('包含其他', $('#kindChips .chip[data-kind="other"]').textContent.trim(), '其他');
    ok('前液选项已移除', $('#kindChips .chip[data-kind="pre"]') === null);

    /* ============ [3] 添加流程：先选类型再保存 ============ */
    click($('#quickAdd'));
    eq('弹层打开', $('#sheet').hidden, false);
    eq('默认选中射精', onChip(), 'ej');
    ok('射精时显示精液量输入', volShown());
    eq('体积单位 mL', $('#volField .unit').textContent.trim(), 'mL');
    eq('体积输入类型', $('#editVol').getAttribute('type'), 'number');
    click($('#editSave'));
    eq('写入 1 条', recs().length, 1);
    eq('类型记为 ej', recs()[0].k, 'ej');
    ok('未填体积则不带 v 字段', recs()[0].v === undefined, JSON.stringify(recs()[0]));
    eq('列表出现 1 条', $$('#recList .rec-item').length, 1);
    eq('列表显示类型徽标', $('#recList .kbadge').textContent.trim(), '射精');

    /* ============ [4] 切换类型时体积输入的显隐 ============ */
    click($('#quickAdd'));
    eq('沿用上次类型', onChip(), 'ej');
    click($('#kindChips .chip[data-kind="other"]'));
    eq('选中其他', onChip(), 'other');
    ok('其他不显示体积输入', !volShown());
    click($('#kindChips .chip[data-kind="fl"]'));
    eq('选中流精', onChip(), 'fl');
    ok('流精显示体积输入', volShown());
    click($('#kindChips .chip[data-kind="ej"]'));
    eq('切回射精', onChip(), 'ej');
    ok('射精显示体积输入', volShown());
    click($('#kindChips .chip[data-kind="fl"]'));
    eq('再切回流精', onChip(), 'fl');
    ok('切回流精再次显示', volShown());

    /* ============ [5] 填写体积并保存 ============ */
    $('#editVol').value = '3.5';
    $('#editTime').value = '07:10';
    click($('#editSave'));
    eq('累计 2 条', recs().length, 2);
    var flRec = recs().filter(function(r){ return r.k === 'fl'; })[0];
    ok('流精记录已保存', !!flRec, JSON.stringify(recs()));
    eq('体积存为 3.5', flRec.v, 3.5);
    eq('时间正确', flRec.t, '07:10');
    eq('列表显示 3.5 mL', $$('#recList .vol')[0].textContent.trim(), '3.5 mL');
    eq('体积渲染一处', $$('#recList .vol').length, 1);

    /* ============ [6] 编辑时回填类型与体积 ============ */
    click($$('#recList .rec-item').filter(function(li){ return li.dataset.id === flRec.id; })[0]);
    eq('回填类型 fl', onChip(), 'fl');
    ok('回填时体积输入可见', volShown());
    eq('回填体积 3.5', $('#editVol').value, '3.5');
    eq('回填时间', $('#editTime').value, '07:10');
    click($('#volClear'));
    eq('清除按钮清空体积', $('#editVol').value, '');
    $('#editVol').value = '5';
    click($('#editSave'));
    eq('体积更新为 5', recs().filter(function(r){ return r.id === flRec.id; })[0].v, 5);

    /* ============ [7] 切到不需要体积的类型时清除体积 ============ */
    click($('#quickAdd'));
    click($('#kindChips .chip[data-kind="fl"]'));
    $('#editVol').value = '2';
    $('#editTime').value = '20:00';
    click($('#editSave'));
    var tmpRec = recByTime('20:00');
    eq('新增流精带体积 2', tmpRec.v, 2);

    click($$('#recList .rec-item').filter(function(li){ return li.dataset.id === tmpRec.id; })[0]);
    click($('#kindChips .chip[data-kind="other"]'));
    ok('切其他后体积输入隐藏', !volShown());
    click($('#editSave'));
    var othRec = recs().filter(function(r){ return r.id === tmpRec.id; })[0];
    eq('类型改为 other', othRec.k, 'other');
    ok('其他记录已清除 v 字段', othRec.v === undefined, JSON.stringify(othRec));

    /* ============ [8] 其他类型 + 非法体积 ============ */
    click($('#quickAdd'));
    click($('#kindChips .chip[data-kind="other"]'));
    $('#editTime').value = '19:30';
    click($('#editSave'));
    eq('其他类型已保存', recByTime('19:30').k, 'other');

    click($('#quickAdd'));
    click($('#kindChips .chip[data-kind="ej"]'));
    $('#editVol').value = '-8';
    $('#editTime').value = '09:05';
    click($('#editSave'));
    var neg = recByTime('09:05');
    ok('负数体积被忽略', neg && neg.v === undefined, JSON.stringify(neg));

    /* ============ [9] 日历圆点按类型着色 ============ */
    var cellToday = $('#calGrid .cell[data-key="' + TK + '"]');
    eq('今天共 5 条记录', recs().length, 5);
    eq('封顶 4 个圆点', cellToday.querySelectorAll('.dots i').length, 4);
    var styles = Array.prototype.map.call(cellToday.querySelectorAll('.dots i'), function(el){
      return el.getAttribute('style') || '';
    });
    ok('圆点带类型颜色', styles.some(function(s){ return s.indexOf('--k-ej') >= 0; })
                       && styles.some(function(s){ return s.indexOf('--k-fl') >= 0; })
                       && styles.some(function(s){ return s.indexOf('--k-other') >= 0; }),
                       styles.join(' / '));

    /* ============ [10] 诱因标签 ============ */
    eq('标签选项 8 个', $$('#tagChips .tag').length, 8);
    eq('首次打开无预选标签', onTags().length, 0);
    click($('#quickAdd'));
    click($('#tagChips .tag[data-tag="stress"]'));
    click($('#tagChips .tag[data-tag="insomnia"]'));
    eq('选中两个标签', onTags().join(','), 'stress,insomnia');
    eq('标签按钮 aria-pressed', $('#tagChips .tag[data-tag="stress"]').getAttribute('aria-pressed'), 'true');
    $('#editTime').value = '08:00';
    click($('#editSave'));
    var tagRec = recByTime('08:00');
    eq('标签写入记录', (tagRec.g || []).join(','), 'stress,insomnia');
    ok('列表显示标签文字', $('#recList').textContent.indexOf('压力大') >= 0
                          && $('#recList').textContent.indexOf('睡不着') >= 0);
    eq('列表标签行 1 处', $$('#recList .tg').length, 1);

    // 重开应该回填，并且默认沿用上次（新增时）
    click($$('#recList .rec-item').filter(function(li){ return li.dataset.id === tagRec.id; })[0]);
    eq('编辑时回填标签', onTags().join(','), 'stress,insomnia');
    click($('#tagChips .tag[data-tag="stress"]'));
    eq('取消一个标签', onTags().join(','), 'insomnia');
    click($('#editSave'));
    eq('标签更新为 1 个', (recByTime('08:00').g || []).join(','), 'insomnia');

    // 新增时沿用上次标签
    click($('#quickAdd'));
    eq('新增沿用上次标签', onTags().join(','), 'insomnia');
    click($('#editCancel'));

    /* ============ [11] 频率提醒 ============ */
    function step(field, dir, times){
      for(var i=0;i<times;i++) click($('.stepper[data-field="' + field + '"] button[data-d="' + dir + '"]'));
    }
    function remindText(){ return $('#remindBox').textContent || ''; }

    eq('提醒卡片 1 张', $$('#remindBox .remind').length, 1);
    ok('触发本周提醒', remindText().indexOf('本周频率偏高') >= 0, remindText());
    ok('本周提醒是警示级', $('#remindBox .remind').classList.contains('warn'));
    ok('未触发本月提醒', remindText().indexOf('本月次数偏多') < 0);
    ok('周提醒含健康提示', remindText().indexOf('睡眠') >= 0, remindText());
    ok('详情默认收起', !$('#remindBox .remind').classList.contains('open'));
    ok('收起时详情不可见', $('#remindBox .rm-tip').offsetHeight === 0);
    click($('#remindBox .remind'));
    ok('点卡片展开详情', $('#remindBox .remind').classList.contains('open'));
    click($('#remindBox .remind'));
    ok('再点一次收起', !$('#remindBox .remind').classList.contains('open'));

    eq('默认周上限 3', $('.stepper[data-field="week"] b').textContent, '3');
    eq('默认月上限 10', $('.stepper[data-field="month"] b').textContent, '10');
    // 阈值测试要跟着实际次数走，别写死 —— 上面加了记录，本周次数已经变了
    var wkTotal = D.stats.weekTotal();
    var up = Math.max(0, wkTotal + 1 - 3);
    step('week', '1', up);
    eq('周上限超过本周次数', parseInt($('.stepper[data-field="week"] b').textContent, 10), wkTotal + 1);
    eq('到上限不提醒', $$('#remindBox .remind').length, 0);
    eq('阈值已持久化', store().settings.remind.week, wkTotal + 1);
    step('week', '-1', up);
    eq('周上限回到 3', $('.stepper[data-field="week"] b').textContent, '3');
    eq('提醒重新出现', $$('#remindBox .remind').length, 1);

    click($('#swRemind'));
    eq('关闭后不提醒', $$('#remindBox .remind').length, 0);
    eq('开关状态已存', store().settings.remind.on, false);
    click($('#swRemind'));
    eq('开启后恢复提醒', $$('#remindBox .remind').length, 1);

    step('month', '-1', 6);
    eq('月上限降到 4', $('.stepper[data-field="month"] b').textContent, '4');
    eq('触发两条提醒', $$('#remindBox .remind').length, 2);
    ok('触发本月提醒', remindText().indexOf('本月次数偏多') >= 0, remindText());
    step('month', '1', 6);
    eq('月上限恢复 10', $('.stepper[data-field="month"] b').textContent, '10');

    click($('#remindBox .rm-x[data-rule="week"]'));
    eq('关闭本周提醒后清空', $$('#remindBox .remind').length, 0);
    ok('关闭记录已持久化', Object.keys(store().settings.remindDismiss).some(function(k){
      return k.indexOf('W:') === 0;
    }), JSON.stringify(store().settings.remindDismiss));

    /* ============ [12] 统计页 ============ */
    click($$('.tab')[1]);
    eq('统计页显示', $('#view-stats').hidden, false);
    eq('类型分布 3 行', $$('#typeDist .tdist-row').length, 3);
    var distNames = $$('#typeDist .tdist-row .nm').map(function(e){ return e.textContent.trim(); });
    ok('分布含全部三类', ['射精','流精','其他'].every(function(n){ return distNames.indexOf(n) >= 0; }), distNames.join(','));
    ok('分布不含前液', distNames.indexOf('前液') < 0, distNames.join(','));
    eq('分布次数合计 6', $$('#typeDist .tdist-row .ct').reduce(function(a, e){
      return a + parseInt(e.textContent, 10);
    }, 0), 6);

    // 诱因分布
    eq('诱因分布 1 行', $$('#tagDist .gdist-row').length, 1);
    eq('诱因名称为睡不着', $('#tagDist .gdist-row .nm').textContent.trim(), '睡不着');
    ok('诱因次数 1', $('#tagDist .gdist-row .ct').textContent.indexOf('1') >= 0,
       $('#tagDist .gdist-row .ct').textContent);

    // 目标达成
    var goalTxt = $('#goalCard').textContent;
    ok('目标卡含本周', goalTxt.indexOf('本周') >= 0, goalTxt);
    ok('目标卡含本月', goalTxt.indexOf('本月') >= 0, goalTxt);
    ok('目标卡显示达标状态', goalTxt.indexOf('超出') >= 0 || goalTxt.indexOf('达标') >= 0, goalTxt);
    ok('目标卡显示连续周数', !!$('#goalCard .goal-streak b'), goalTxt);

    var volRow = $$('#detailRows .row').filter(function(r){
      return r.querySelector('.rk').textContent === '精液量均值';
    })[0];
    eq('精液量均值 5.0 mL', volRow.querySelector('.rv').textContent, '5.0 mL');
    var nRow = $$('#detailRows .row').filter(function(r){
      return r.querySelector('.rk').textContent === '有测量记录';
    })[0];
    eq('测量次数 1', nRow.querySelector('.rv').textContent, '1 次');
    var dayRow = $$('#detailRows .row').filter(function(r){
      return r.querySelector('.rk').textContent === '记录总天数';
    })[0];
    eq('记录总天数 1 天', dayRow.querySelector('.rv').textContent, '1 天');

    /* ============ [13] 月份切换 / 设置 / 主题 ============ */
    click($$('.tab')[0]);
    var m0 = $('#monthTitle').textContent;
    click($('#prevMonth'));
    ok('上个月标题变化', $('#monthTitle').textContent !== m0);
    click($('#nextMonth'));
    eq('回到本月', $('#monthTitle').textContent, m0);

    click($$('.tab')[2]);
    eq('设置页显示', $('#view-settings').hidden, false);
    var ws = $('#setWeekStart');
    ws.value = '0';
    ws.dispatchEvent(new Event('change'));
    eq('周起始日保存', store().settings.weekStart, 0);
    eq('表头首列变周日', $$('#weekdays span')[0].textContent, '日');
    ws.value = '1';
    ws.dispatchEvent(new Event('change'));
    eq('表头首列回周一', $$('#weekdays span')[0].textContent, '一');

    var t0 = document.documentElement.getAttribute('data-theme');
    click($('#themeBtn'));
    var t1 = document.documentElement.getAttribute('data-theme');
    ok('主题已切换', t0 !== t1, t0 + '->' + t1);
    eq('下拉框同步', $('#setTheme').value, t1);

    /* ============ [14] 可访问性 ============ */
    eq('隐私锁开关 role', $('#swPin').getAttribute('role'), 'switch');
    eq('隐私锁开关 tabindex', $('#swPin').getAttribute('tabindex'), '0');
    eq('提醒开关 role', $('#swRemind').getAttribute('role'), 'switch');
    eq('每日提醒开关 role', $('#swDaily').getAttribute('role'), 'switch');
    eq('开关 aria-checked 跟随状态', $('#swRemind').getAttribute('aria-checked'),
       store().settings.remind.on ? 'true' : 'false');
    click($$('.tab')[0]);
    ok('记录行可聚焦', $('#recList .rec-item').getAttribute('tabindex') === '0');
    eq('记录行 role', $('#recList .rec-item').getAttribute('role'), 'button');
    ok('记录行有 aria-label', ($('#recList .rec-item').getAttribute('aria-label') || '').length > 0);
    ok('日历格有 aria-label', ($('#calGrid .cell[data-key="' + TK + '"]').getAttribute('aria-label') || '').length > 0);

    // 键盘能操作开关
    var beforeOn = store().settings.remind.on;
    key($('#swRemind'), ' ');
    eq('空格键切换开关', store().settings.remind.on, !beforeOn);
    key($('#swRemind'), 'Enter');
    eq('回车键切换开关', store().settings.remind.on, beforeOn);

    // 键盘能打开记录
    key($('#recList .rec-item'), 'Enter');
    eq('回车打开记录弹层', $('#sheet').hidden, false);
    click($('#editCancel'));

    /* ============ [15] 每日提醒设置 ============ */
    click($$('.tab')[2]);
    eq('默认关闭每日提醒', store().settings.daily.on, false);
    click($('#swDaily'));
    eq('开启每日提醒', store().settings.daily.on, true);
    eq('时间输入框启用', $('#setDailyTime').disabled, false);
    var dti = $('#setDailyTime');
    dti.value = '22:30';
    dti.dispatchEvent(new Event('change'));
    eq('提醒时间已保存', store().settings.daily.time, '22:30');
    click($('#swDaily'));
    eq('关闭每日提醒', store().settings.daily.on, false);
    eq('关闭后时间输入框禁用', $('#setDailyTime').disabled, true);

    /* ============ [16] 撤销删除 ============ */
    click($$('.tab')[0]);
    var beforeDel = recs().length;
    click($$('#recList .rec-item')[0]);
    // confirm() 在无头环境里由测试桩接管，直接放行
    window.confirm = function(){ return true; };
    click($('#editDelete'));
    eq('记录已删除', recs().length, beforeDel - 1);
    ok('出现撤销按钮', !!$('#toast .act'), $('#toast').textContent);
    ok('撤销提示是删除', $('#toast').textContent.indexOf('已删除') >= 0, $('#toast').textContent);
    click($('#toast .act'));
    eq('撤销后记录恢复', recs().length, beforeDel);
    ok('恢复提示', $('#toast').textContent.indexOf('已恢复') >= 0, $('#toast').textContent);

    /* ============ [17] 长按快速记录 ============ */
    var beforeLP = recs().length;
    var lpCell = $('#calGrid .cell[data-key="' + TK + '"]');
    lpCell.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true }));
    await sleep(640);
    lpCell.dispatchEvent(new PointerEvent('pointerup', { bubbles:true, cancelable:true }));
    eq('长按新增一条', recs().length, beforeLP + 1);
    ok('长按用上次的类型', recs()[recs().length-1].k === store().settings.lastKind,
       recs()[recs().length-1].k);
    ok('长按提示可撤销', $('#toast').textContent.indexOf('已记录') >= 0, $('#toast').textContent);
    click($('#toast .act'));
    eq('撤销长按记录', recs().length, beforeLP);

    /* ============ [18] 隐私锁：PBKDF2 + 失败锁定 ============ */
    click($$('.tab')[2]);
    click($('#swPin'));
    eq('锁屏出现', $('#lockScreen').hidden, false);
    eq('4 个密码点', $$('#pinDots i').length, 4);
    eq('键盘 12 键', $$('#keypad button').length, 12);
    pin('2468');
    await sleep(300);
    eq('进入确认阶段', $('#lockTitle').textContent, '确认密码');
    pin('2468');
    await sleep(900);   // PBKDF2 是异步的，多等一会儿
    eq('锁屏已关闭', $('#lockScreen').hidden, true);

    var st2 = store().settings;
    ok('密码用 PBKDF2 存储', /^p2:\d+:[0-9a-f]{64}$/.test(st2.pin), st2.pin);
    ok('保存了随机盐', /^[0-9a-f]{32}$/.test(st2.pinSalt), st2.pinSalt);
    ok('迭代次数合理', st2.pinIter >= 50000, String(st2.pinIter));
    ok('明文没有落盘', JSON.stringify(st2).indexOf('2468') < 0);
    eq('开关点亮', $('#swPin').classList.contains('on'), true);

    // 输错密码
    D.lock.show('unlock');
    pin('1111');
    await sleep(700);
    eq('密码错误时锁屏保留', $('#lockScreen').hidden, false);
    ok('提示密码不对', $('#lockSub').textContent.indexOf('不对') >= 0, $('#lockSub').textContent);
    eq('错误次数已记录', store().settings.pinFails.n, 1);
    eq('密码点已清空', $$('#pinDots i.on').length, 0);

    // 输对密码
    pin('2468');
    await sleep(700);
    eq('正确密码解锁', $('#lockScreen').hidden, true);
    eq('解锁后错误计数清零', store().settings.pinFails.n, 0);

    /* ============ [19] 数据完整性 ============ */
    var s = store();
    eq('数据版本号', s.version, 2);
    eq('记录天数 1', Object.keys(s.records).length, 1);
    ok('每条记录都有类型', s.records[TK].every(function(r){ return r.k; }),
       JSON.stringify(s.records[TK].map(function(r){ return r.k; })));
    ok('只有需要体积的类型才带 v', s.records[TK].every(function(r){
      return r.v === undefined || r.k === 'ej' || r.k === 'fl';
    }));
    ok('所有 v 都是非负数字', s.records[TK].every(function(r){
      return r.v === undefined || (typeof r.v === 'number' && r.v >= 0);
    }));
    ok('时间格式合法', s.records[TK].every(function(r){ return /^\d{2}:\d{2}$/.test(r.t); }));
    ok('标签都是已知 id', s.records[TK].every(function(r){
      return r.g === undefined || r.g.every(function(g){
        return ['stress','bored','insomnia','alone','media','habit','tired','anxious'].indexOf(g) >= 0;
      });
    }));
    ok('每条记录 id 唯一', (function(){
      var ids = s.records[TK].map(function(r){ return r.id; });
      return new Set(ids).size === ids.length;
    })());
    eq('上次类型已记住', s.settings.lastKind, 'ej');
    ok('上次标签已记住', (s.settings.lastTags || []).indexOf('insomnia') >= 0,
       JSON.stringify(s.settings.lastTags));

    /* ============ [20] 连续天数 / 深夜时段提醒 ============ */
    click($$('.tab')[0]);
    function addOn(off, time){
      var dd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - off);
      var kk = dd.getFullYear() + '-' + pad(dd.getMonth()+1) + '-' + pad(dd.getDate());
      click($('#calGrid .cell[data-key="' + kk + '"]'));
      click($('#addForDay'));
      $('#editTime').value = time;
      click($('#editSave'));
    }
    addOn(1, '02:00');
    addOn(2, '02:30');
    addOn(3, '03:00');

    var rt = $('#remindBox').textContent || '';
    ok('触发连续天数提醒', rt.indexOf('已经连续 4 天') >= 0, rt);
    ok('触发深夜时段提醒', rt.indexOf('深夜时段偏多') >= 0, rt);
    eq('两条提示级提醒', $$('#remindBox .remind.note').length, 2);
    eq('提醒总数 2 张', $$('#remindBox .remind').length, 2);
    ok('已关闭的本周提醒不再出现', rt.indexOf('本周频率偏高') < 0, rt);

    click($$('.tab')[1]);
    var nightRow = $$('#detailRows .row').filter(function(r){
      return r.querySelector('.rk').textContent === '本月深夜时段';
    })[0];
    eq('深夜计数 3 次', nightRow.querySelector('.rv').textContent, '3 次');
    var srec = store().records, allRecs = 0;
    Object.keys(srec).forEach(function(k2){ allRecs += srec[k2].length; });
    eq('今天 6 条记录', srec[TK].length, 6);
    eq('总记录数 = 今天 6 条 + 补记 3 条', allRecs, srec[TK].length + 3);
    eq('记录天数 4', Object.keys(srec).length, 4);
    ok('深夜记录时间格式未受影响', srec[TK].every(function(r){ return /^\d{2}:\d{2}$/.test(r.t); }));

    /* ============ [21] 回归：编辑「有体积无类型」的老记录不该丢体积 ============ */
    // 用当前网格里的第一格，避免依赖月份位置
    var freeKey = $$('#calGrid .cell')[0].dataset.key;
    D.S.records[freeKey] = [{ id:'legacy1', t:'10:00', n:'老记录', v: 3.5 }];
    D.save(); D.render();
    click($('#calGrid .cell[data-key="' + freeKey + '"]'));
    click($('#recList .rec-item'));
    eq('老记录弹层已打开', $('#sheet').hidden, false);
    eq('无类型时不选中任何类型', onChip(), null);
    ok('有体积时体积输入可见', volShown());
    eq('体积已回填', $('#editVol').value, '3.5');
    click($('#editSave'));
    var legacy = store().records[freeKey][0];
    ok('直接保存后体积仍在', legacy.v === 3.5, JSON.stringify(legacy));
    ok('类型仍为空', legacy.k === undefined, JSON.stringify(legacy));

    // 收尾：把这天删掉，别影响别的断言
    delete D.S.records[freeKey];
    D.save(); D.render();

    /* ============ [22] 多语言 ============ */
    var zhKeys = Object.keys(D.STRINGS.zh).sort();
    var enKeys = Object.keys(D.STRINGS.en).sort();
    var missEn = zhKeys.filter(function(k){ return enKeys.indexOf(k) < 0; });
    var missZh = enKeys.filter(function(k){ return zhKeys.indexOf(k) < 0; });
    ok('中英文字符串表 key 完全一致', missEn.length === 0 && missZh.length === 0,
       'en 缺 [' + missEn.join(',') + '] zh 缺 [' + missZh.join(',') + ']');
    ok('字符串表规模合理', zhKeys.length > 120, String(zhKeys.length));

    // 静态属性引用的 key 必须两个语言都有，否则切过去会漏出原始 key
    var badKeys = [];
    ['data-i18n','data-i18n-html','data-i18n-ph','data-i18n-aria','data-i18n-title'].forEach(function(attr){
      $$('[' + attr + ']').forEach(function(el){
        var k = el.getAttribute(attr);
        if(D.STRINGS.zh[k] === undefined || D.STRINGS.en[k] === undefined) badKeys.push(attr + '=' + k);
      });
    });
    ok('静态属性引用的 key 都存在', badKeys.length === 0, badKeys.join(', '));

    eq('初始为中文', D.lang, 'zh');
    var zhBrand = $('.brand span:last-child').textContent.trim();
    var zhTab1 = $$('.tab span')[1].textContent.trim();

    // —— 切到英文 ——
    var selLang = $('#setLang');
    selLang.value = 'en';
    selLang.dispatchEvent(new Event('change'));
    eq('切换后 LANG 为 en', D.lang, 'en');
    eq('语言已持久化', store().settings.lang, 'en');
    eq('品牌名变英文', $('.brand span:last-child').textContent.trim(), 'Private Journal');
    eq('导航变英文', $$('.tab span')[1].textContent.trim(), 'Stats');
    eq('html lang 属性已更新', document.documentElement.getAttribute('lang'), 'en');
    eq('类型按钮变英文', $('#kindChips .chip[data-kind="ej"]').textContent.trim(), 'Ejaculation');
    eq('标签按钮变英文', $('#tagChips .tag[data-tag="stress"]').textContent.trim(), 'Stressed');
    ok('月份标题变英文', /[A-Za-z]/.test($('#monthTitle').textContent), $('#monthTitle').textContent);
    ok('星期表头变英文', /[A-Za-z]/.test($('#weekdays span').textContent), $('#weekdays span').textContent);
    ok('详细数据变英文', $('#detailRows').textContent.indexOf('Days logged') >= 0,
       $('#detailRows').textContent.slice(0, 60));
    ok('目标卡变英文', $('#goalCard').textContent.indexOf('This week') >= 0,
       $('#goalCard').textContent.slice(0, 60));
    eq('开关 aria 变英文', $('#swPin').getAttribute('aria-label'), 'Passcode lock');
    ok('输入框 placeholder 变英文',
       $('#editNote').getAttribute('placeholder').indexOf('Anything') >= 0,
       $('#editNote').getAttribute('placeholder'));
    eq('数字键盘变英文', $('#keypad button[data-k="del"]').textContent.trim(), 'Del');
    eq('补记按钮变英文', $('#addForDay').textContent.trim(), '+ Add an entry for this day');
    ok('主按钮变英文', $('#quickAdd').textContent.indexOf('Add entry') >= 0,
       $('#quickAdd').textContent);

    D.lock.show('unlock');
    eq('锁屏标题变英文', $('#lockTitle').textContent, 'Enter passcode');
    D.lock.hide();

    // —— 切回中文 ——
    selLang = $('#setLang');
    selLang.value = 'zh';
    selLang.dispatchEvent(new Event('change'));
    eq('切回中文', D.lang, 'zh');
    eq('品牌名回中文', $('.brand span:last-child').textContent.trim(), zhBrand);
    eq('导航回中文', $$('.tab span')[1].textContent.trim(), zhTab1);
    eq('html lang 属性回中文', document.documentElement.getAttribute('lang'), 'zh-CN');
    eq('类型按钮回中文', $('#kindChips .chip[data-kind="ej"]').textContent.trim(), '射精');

    // —— 跟随系统：headless 里 navigator.language 是 en-US，应解析成 en ——
    selLang = $('#setLang');
    selLang.value = 'system';
    selLang.dispatchEvent(new Event('change'));
    var sysLang = /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
    eq('跟随系统按 navigator.language 解析', D.lang, sysLang);
    selLang = $('#setLang');
    selLang.value = 'zh';
    selLang.dispatchEvent(new Event('change'));
    eq('恢复中文', D.lang, 'zh');

    /* ============ [23] 汇总 ============ */
    ok('页面无 JS 报错', window.__errCount === 0,
       window.__errCount + ' 个: ' + (window.__errMsgs || []).slice(0, 5).join(' | '));

  }catch(e){
    fail++;
    out.push('EXCEPTION|' + (e && e.message ? e.message : String(e)));
  }

  var el = document.createElement('pre');
  el.id = 'TESTRESULT';
  el.textContent = 'SUMMARY|pass=' + pass + '|fail=' + fail + '\n' + out.join('\n');
  document.body.appendChild(el);
  document.title = 'DONE pass=' + pass + ' fail=' + fail;
})();
