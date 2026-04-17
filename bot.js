// ═══════════════════════════════════════════════════════════════
//  TaskMarket Bot — xRocket Payments + TON only
//  node bot.js   (webhook mode — single instance safe)
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');

// ── Clientes ────────────────────────────────────────────────────
// WEBHOOK_URL deve ser o URL público do servidor, ex: https://myapp.onrender.com
// O bot nunca inicia polling — uma só instância processa todos os updates.
// No Render, RENDER_EXTERNAL_URL é definido automaticamente — usado como fallback.
const WEBHOOK_URL  = process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL;
const WEBHOOK_PATH = `/webhook/${process.env.BOT_TOKEN}`; // path secreto
const PORT         = process.env.PORT || 3000;

const bot = new TelegramBot(process.env.BOT_TOKEN, { webHook: false });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const XROCKET_TOKEN = process.env.XROCKET_TOKEN;
const XROCKET_API   = 'https://pay.xrocket.tg';

// ── Estado em memória (wizard de criação de tarefa) ─────────────
const wizards = {};

// ════════════════════════════════════════════════════════════════
//  HELPERS — xRocket API
// ════════════════════════════════════════════════════════════════
async function xrocketPost(path, body) {
  const res = await fetch(`${XROCKET_API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Rocket-Pay-Key': XROCKET_TOKEN },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function xrocketGet(path) {
  const res = await fetch(`${XROCKET_API}${path}`, {
    headers: { 'Rocket-Pay-Key': XROCKET_TOKEN },
  });
  return res.json();
}

async function createInvoice(amountTon, description, payload) {
  const data = await xrocketPost('/tg-invoices', {
    currency: 'TONCOIN', amount: amountTon, description, payload, expiredIn: 3600,
  });
  if (!data.success) throw new Error(data.message || 'xRocket invoice error');
  return { invoice_id: data.data.id, pay_url: data.data.link };
}

async function getInvoiceStatus(invoice_id) {
  const data = await xrocketGet(`/tg-invoices/${invoice_id}`);
  if (!data.success) return null;
  return data.data.status;
}

async function transferToUser(telegramUserId, amountTon, description) {
  const data = await xrocketPost('/transfers', {
    tgUserId: telegramUserId, currency: 'TONCOIN', amount: amountTon,
    transferId: `tx_${Date.now()}_${telegramUserId}`, description,
  });
  return data.success;
}

// ════════════════════════════════════════════════════════════════
//  HELPERS — Supabase
// ════════════════════════════════════════════════════════════════
async function getOrCreateUser(telegramId, username, referredBy = null) {
  let { data: user } = await supabase
    .from('users').select('*').eq('telegram_id', String(telegramId)).single();

  if (!user) {
    const insert = { telegram_id: String(telegramId), username };
    if (referredBy) {
      const { data: referrer } = await supabase
        .from('users').select('id,ton_balance,referral_count').eq('telegram_id', String(referredBy)).single();
      if (referrer) {
        insert.referred_by = referrer.id;
        await supabase.from('users').update({
          ton_balance:    (parseFloat(referrer.ton_balance || 0) + 0.01).toFixed(6),
          referral_count: (referrer.referral_count || 0) + 1,
        }).eq('id', referrer.id);
        await supabase.from('referrals').insert({
          referrer_id: referrer.id, referred_telegram: String(telegramId), ton_credited: 0.01,
        });
      }
    }
    const { data: newUser } = await supabase.from('users').insert(insert).select().single();
    user = newUser;
  }
  return user;
}

async function getUser(telegramId) {
  const { data } = await supabase.from('users').select('*').eq('telegram_id', String(telegramId)).single();
  return data;
}

// ════════════════════════════════════════════════════════════════
//  UI HELPERS
// ════════════════════════════════════════════════════════════════
function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: '➕ Criar Tarefa', callback_data: 'menu_create' }, { text: '📋 Ver Tarefas',  callback_data: 'menu_tasks'   }],
      [{ text: '💰 Depositar',    callback_data: 'menu_deposit' }, { text: '💼 Meu Perfil',   callback_data: 'menu_profile' }],
      [{ text: '👥 Referências',  callback_data: 'menu_referral' }],
    ],
  };
}

function backBtn(data = 'menu_back') {
  return { inline_keyboard: [[{ text: '⬅️ Voltar', callback_data: data }]] };
}

function ton(val) {
  return `${parseFloat(val || 0).toFixed(4)} TON`;
}

function statusLabel(s) {
  return { open: '🟢 Aberta', in_progress: '🔵 Em Progresso', pending_review: '🟡 A Rever', completed: '✅ Concluída', cancelled: '❌ Cancelada' }[s] || s;
}

// ════════════════════════════════════════════════════════════════
//  /start
// ════════════════════════════════════════════════════════════════
bot.onText(/\/start(?:\s+(\d+))?/, async (msg, match) => {
  const chatId   = msg.chat.id;
  const userId   = msg.from.id;
  const username = msg.from.username || msg.from.first_name;
  const refId    = match?.[1] || null;

  await getOrCreateUser(userId, username, refId);

  await bot.sendMessage(chatId,
    `👋 Bem-vindo ao *TaskMarket*, ${username}!\n\n` +
    `• 📢 *Publicar tarefas* e pagar executores em TON\n` +
    `• ✅ *Completar tarefas* e ganhar TON\n` +
    `• 💎 *Ganhar TON* por referências\n\n` +
    `Usa o menu abaixo para começar:`,
    { parse_mode: 'Markdown', reply_markup: mainMenu() }
  );
});

// ════════════════════════════════════════════════════════════════
//  CALLBACK QUERIES
// ════════════════════════════════════════════════════════════════
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data   = query.data;
  const msgId  = query.message.message_id;

  await bot.answerCallbackQuery(query.id);

  // ── Menu principal ──────────────────────────────────────────
  if (data === 'menu_back') {
    return bot.editMessageText('🏠 Menu Principal:', {
      chat_id: chatId, message_id: msgId, reply_markup: mainMenu(),
    });
  }

  // ── Perfil ──────────────────────────────────────────────────
  if (data === 'menu_profile') {
    const user = await getUser(userId);
    if (!user) return;
    return bot.editMessageText(
      `👤 *Meu Perfil*\n\n` +
      `🆔 Telegram ID: \`${userId}\`\n` +
      `💎 Saldo TON: *${ton(user.ton_balance)}*\n` +
      `👥 Referências: ${user.referral_count || 0}\n\n` +
      `_Podes sacar TON com 25+ referências_`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '💎 Sacar TON', callback_data: 'withdraw_ton' }],
          [{ text: '⬅️ Voltar',    callback_data: 'menu_back'    }],
        ]},
      }
    );
  }

  // ── Referências ─────────────────────────────────────────────
  if (data === 'menu_referral') {
    const user = await getUser(userId);
    const link = `https://t.me/${(await bot.getMe()).username}?start=${userId}`;
    return bot.editMessageText(
      `👥 *Sistema de Referências*\n\n` +
      `💎 Ganhas *0.01 TON* por cada novo utilizador.\n\n` +
      `🔗 O teu link:\n\`${link}\`\n\n` +
      `📊 Total de referências: *${user?.referral_count || 0}*\n` +
      `💰 Saldo TON acumulado: *${ton(user?.ton_balance)}*\n\n` +
      `_Mínimo para sacar: 25 referências_`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '💎 Sacar TON', callback_data: 'withdraw_ton' }],
          [{ text: '⬅️ Voltar',    callback_data: 'menu_back'    }],
        ]},
      }
    );
  }

  // ── Sacar TON ───────────────────────────────────────────────
  if (data === 'withdraw_ton') {
    const user = await getUser(userId);
    if (!user || (user.referral_count || 0) < 25) {
      return bot.editMessageText(
        `❌ Precisas de pelo menos *25 referências* para sacar.\nActualmente tens *${user?.referral_count || 0}*.`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: backBtn('menu_referral') }
      );
    }
    const tonAmt = parseFloat(user.ton_balance || 0);
    if (tonAmt < 0.01) {
      return bot.editMessageText(`❌ Saldo TON insuficiente (${ton(tonAmt)}).`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: backBtn('menu_profile') });
    }
    const ok = await transferToUser(userId, tonAmt, 'Saque de referências TaskMarket');
    if (!ok) {
      return bot.editMessageText(`❌ Erro ao processar transferência. Tenta mais tarde.`,
        { chat_id: chatId, message_id: msgId, reply_markup: backBtn('menu_profile') });
    }
    await supabase.from('users').update({ ton_balance: 0 }).eq('telegram_id', String(userId));
    await supabase.from('transactions').insert({ user_id: user.id, type: 'ton_withdrawal', amount: tonAmt, note: 'Saque via xRocket' });
    return bot.editMessageText(
      `✅ *${ton(tonAmt)}* enviados para a tua carteira via xRocket!`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: backBtn('menu_profile') }
    );
  }

  // ── Depositar ───────────────────────────────────────────────
  if (data === 'menu_deposit') {
    return bot.editMessageText(
      `💰 *Depositar Fundos*\n\nEscolhe o valor a depositar em TON:`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '0.5 TON', callback_data: 'deposit_0.5' }, { text: '1 TON',  callback_data: 'deposit_1'  }],
          [{ text: '2 TON',   callback_data: 'deposit_2'   }, { text: '5 TON',  callback_data: 'deposit_5'  }],
          [{ text: '10 TON',  callback_data: 'deposit_10'  }],
          [{ text: '⬅️ Voltar', callback_data: 'menu_back' }],
        ]},
      }
    );
  }

  // ── Processar depósito ──────────────────────────────────────
  if (data.startsWith('deposit_')) {
    const amtTon = parseFloat(data.split('_')[1]);
    const user   = await getUser(userId);
    if (!user) return;

    let invoice;
    try {
      invoice = await createInvoice(amtTon, `Depósito TaskMarket — ${amtTon} TON`, `deposit_${user.id}`);
    } catch (err) {
      return bot.editMessageText(`❌ Erro ao gerar invoice: ${err.message}`,
        { chat_id: chatId, message_id: msgId, reply_markup: backBtn('menu_deposit') });
    }

    await supabase.from('deposit_invoices').insert({
      user_id: user.id, invoice_id: invoice.invoice_id, amount_ton: amtTon, status: 'pending',
    });

    return bot.editMessageText(
      `🧾 *Invoice gerada!*\n\n` +
      `💎 Valor: *${amtTon} TON*\n` +
      `🆔 Invoice ID: \`${invoice.invoice_id}\`\n\n` +
      `Clica no botão abaixo para pagar via xRocket.\nO saldo é creditado automaticamente.`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '💳 Pagar com xRocket', url: invoice.pay_url }],
          [{ text: '🔄 Verificar Pagamento', callback_data: `check_${invoice.invoice_id}` }],
          [{ text: '⬅️ Voltar', callback_data: 'menu_back' }],
        ]},
      }
    );
  }

  // ── Verificar pagamento ─────────────────────────────────────
  if (data.startsWith('check_')) {
    const invoiceId = data.replace('check_', '');
    const status    = await getInvoiceStatus(invoiceId);

    if (status === 'paid') {
      const { data: inv } = await supabase
        .from('deposit_invoices').select('*, users(*)').eq('invoice_id', invoiceId).single();
      if (inv && inv.status !== 'paid') {
        await supabase.from('deposit_invoices').update({ status: 'paid', paid_at: new Date() }).eq('invoice_id', invoiceId);
        const newBal = (parseFloat(inv.users.ton_balance || 0) + parseFloat(inv.amount_ton)).toFixed(6);
        await supabase.from('users').update({ ton_balance: newBal }).eq('id', inv.user_id);
        await supabase.from('transactions').insert({ user_id: inv.user_id, type: 'deposit', amount: inv.amount_ton, note: `Depósito ${inv.amount_ton} TON` });
      }
      return bot.editMessageText(
        `✅ *Pagamento confirmado!*\n\n💎 ${inv?.amount_ton || ''} TON adicionados ao teu saldo.`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: backBtn() }
      );
    }

    if (status === 'expired') {
      await supabase.from('deposit_invoices').update({ status: 'expired' }).eq('invoice_id', invoiceId);
      return bot.editMessageText(`⏰ Invoice expirada. Cria um novo depósito.`,
        { chat_id: chatId, message_id: msgId, reply_markup: backBtn('menu_deposit') });
    }

    return bot.editMessageText(`⏳ Pagamento ainda pendente. Aguarda e verifica novamente.`, {
      chat_id: chatId, message_id: msgId,
      reply_markup: { inline_keyboard: [
        [{ text: '🔄 Verificar Novamente', callback_data: `check_${invoiceId}` }],
        [{ text: '⬅️ Voltar', callback_data: 'menu_back' }],
      ]},
    });
  }

  // ── Ver tarefas ─────────────────────────────────────────────
  if (data === 'menu_tasks') {
    const { data: tasks } = await supabase
      .from('tasks').select('*').eq('status', 'open')
      .order('created_at', { ascending: false }).limit(10);

    if (!tasks || tasks.length === 0) {
      return bot.editMessageText(`📋 Não há tarefas disponíveis de momento.`,
        { chat_id: chatId, message_id: msgId, reply_markup: backBtn() });
    }

    const buttons = tasks.map(t => ([{ text: `#${t.id} ${t.title} — ${ton(t.reward)}`, callback_data: `task_view_${t.id}` }]));
    buttons.push([{ text: '⬅️ Voltar', callback_data: 'menu_back' }]);

    return bot.editMessageText(
      `📋 *Tarefas disponíveis* (${tasks.length}):`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
    );
  }

  // ── Detalhe de tarefa ───────────────────────────────────────
  if (data.startsWith('task_view_')) {
    const taskId = parseInt(data.split('_')[2]);
    const { data: task } = await supabase.from('tasks').select('*').eq('id', taskId).single();
    if (!task) return;

    const user       = await getUser(userId);
    const isOwner    = user && task.advertiser_id === user.id;
    const isExecutor = user && task.executor_id   === user.id;

    const buttons = [];
    if (task.status === 'open' && !isOwner)
      buttons.push([{ text: '✅ Aceitar Tarefa', callback_data: `task_accept_${taskId}` }]);
    if (task.status === 'in_progress' && isExecutor)
      buttons.push([{ text: '📤 Submeter Conclusão', callback_data: `task_done_${taskId}` }]);
    if (task.status === 'pending_review' && isOwner)
      buttons.push([
        { text: '✅ Aprovar', callback_data: `task_approve_${taskId}` },
        { text: '❌ Rejeitar', callback_data: `task_reject_${taskId}` },
      ]);
    if (isOwner && task.status === 'open')
      buttons.push([{ text: '🗑️ Cancelar', callback_data: `task_cancel_${taskId}` }]);
    buttons.push([{ text: '⬅️ Voltar', callback_data: 'menu_tasks' }]);

    return bot.editMessageText(
      `📌 *Tarefa #${task.id}*\n\n` +
      `📝 ${task.title}\n` +
      `${task.description ? `📄 ${task.description}\n` : ''}` +
      `💎 Recompensa: *${ton(task.reward)}*\n` +
      `⏰ Prazo: ${task.deadline || 'Sem prazo'}\n` +
      `📊 Estado: *${statusLabel(task.status)}*`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
    );
  }

  // ── Aceitar tarefa ──────────────────────────────────────────
  if (data.startsWith('task_accept_')) {
    const taskId = parseInt(data.split('_')[2]);
    const user   = await getUser(userId);
    const { data: task } = await supabase.from('tasks').select('*').eq('id', taskId).single();

    if (!task || task.status !== 'open')
      return bot.editMessageText(`❌ Tarefa já não disponível.`, { chat_id: chatId, message_id: msgId, reply_markup: backBtn('menu_tasks') });
    if (task.advertiser_id === user?.id)
      return bot.editMessageText(`❌ Não podes aceitar a tua própria tarefa.`, { chat_id: chatId, message_id: msgId, reply_markup: backBtn('menu_tasks') });

    await supabase.from('tasks').update({ status: 'in_progress', executor_id: user.id }).eq('id', taskId);

    const { data: adv } = await supabase.from('users').select('telegram_id').eq('id', task.advertiser_id).single();
    if (adv) bot.sendMessage(adv.telegram_id, `🔔 A tua tarefa *#${taskId} "${task.title}"* foi aceite por @${query.from.username || userId}!`, { parse_mode: 'Markdown' }).catch(() => null);

    return bot.editMessageText(
      `✅ *Tarefa aceite!*\n\n📝 ${task.title}\n💎 Recompensa: ${ton(task.reward)}`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '📤 Submeter Conclusão', callback_data: `task_done_${taskId}` }],
          [{ text: '⬅️ Menu', callback_data: 'menu_back' }],
        ]},
      }
    );
  }

  // ── Submeter conclusão ──────────────────────────────────────
  if (data.startsWith('task_done_')) {
    const taskId = parseInt(data.split('_')[2]);
    const user   = await getUser(userId);
    const { data: task } = await supabase.from('tasks').select('*').eq('id', taskId).single();

    if (!task || task.executor_id !== user?.id || task.status !== 'in_progress')
      return bot.editMessageText(`❌ Operação inválida.`, { chat_id: chatId, message_id: msgId, reply_markup: backBtn('menu_tasks') });

    await supabase.from('tasks').update({ status: 'pending_review' }).eq('id', taskId);

    const { data: adv } = await supabase.from('users').select('telegram_id').eq('id', task.advertiser_id).single();
    if (adv) bot.sendMessage(adv.telegram_id,
      `📩 A tarefa *#${taskId} "${task.title}"* foi submetida para revisão!`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
        { text: '✅ Aprovar', callback_data: `task_approve_${taskId}` },
        { text: '❌ Rejeitar', callback_data: `task_reject_${taskId}` },
      ]]}},
    ).catch(() => null);

    return bot.editMessageText(`📤 *Conclusão submetida!*\n\nAguarda a aprovação para receber o pagamento.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: backBtn() });
  }

  // ── Aprovar tarefa ──────────────────────────────────────────
  if (data.startsWith('task_approve_')) {
    const taskId = parseInt(data.split('_')[2]);
    const user   = await getUser(userId);
    const { data: task } = await supabase.from('tasks').select('*').eq('id', taskId).single();

    if (!task || task.advertiser_id !== user?.id || task.status !== 'pending_review')
      return bot.editMessageText(`❌ Operação inválida.`, { chat_id: chatId, message_id: msgId, reply_markup: backBtn() });

    const { error } = await supabase.rpc('pay_executor', { task_id: taskId });
    if (error)
      return bot.editMessageText(`❌ Erro ao pagar executor: ${error.message}`, { chat_id: chatId, message_id: msgId, reply_markup: backBtn() });

    await supabase.from('tasks').update({ status: 'completed' }).eq('id', taskId);

    const { data: exec } = await supabase.from('users').select('telegram_id').eq('id', task.executor_id).single();
    if (exec) bot.sendMessage(exec.telegram_id,
      `🎉 Tarefa *#${taskId} "${task.title}"* aprovada!\n\n💎 *${ton(task.reward)}* creditados no teu saldo.`,
      { parse_mode: 'Markdown' }
    ).catch(() => null);

    return bot.editMessageText(`✅ *Tarefa aprovada!*\n\n💎 ${ton(task.reward)} pagos ao executor.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: backBtn() });
  }

  // ── Rejeitar tarefa ─────────────────────────────────────────
  if (data.startsWith('task_reject_')) {
    const taskId = parseInt(data.split('_')[2]);
    const user   = await getUser(userId);
    const { data: task } = await supabase.from('tasks').select('*').eq('id', taskId).single();

    if (!task || task.advertiser_id !== user?.id || task.status !== 'pending_review')
      return bot.editMessageText(`❌ Operação inválida.`, { chat_id: chatId, message_id: msgId, reply_markup: backBtn() });

    await supabase.from('tasks').update({ status: 'in_progress' }).eq('id', taskId);

    const { data: exec } = await supabase.from('users').select('telegram_id').eq('id', task.executor_id).single();
    if (exec) bot.sendMessage(exec.telegram_id,
      `⚠️ A tua submissão para *#${taskId} "${task.title}"* foi *rejeitada*.\n\nCorrige e resubmete.`,
      { parse_mode: 'Markdown' }
    ).catch(() => null);

    return bot.editMessageText(`❌ Submissão rejeitada. Executor notificado.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: backBtn() });
  }

  // ── Cancelar tarefa ─────────────────────────────────────────
  if (data.startsWith('task_cancel_')) {
    const taskId = parseInt(data.split('_')[2]);
    const user   = await getUser(userId);
    const { data: task } = await supabase.from('tasks').select('*').eq('id', taskId).single();

    if (!task || task.advertiser_id !== user?.id)
      return bot.editMessageText(`❌ Sem permissão.`, { chat_id: chatId, message_id: msgId, reply_markup: backBtn() });

    const newBal = (parseFloat(user.ton_balance || 0) + parseFloat(task.reward)).toFixed(6);
    await supabase.from('users').update({ ton_balance: newBal }).eq('id', user.id);
    await supabase.from('tasks').update({ status: 'cancelled' }).eq('id', taskId);
    await supabase.from('transactions').insert({ user_id: user.id, type: 'receipt', amount: task.reward, task_id: taskId, note: 'Devolução por cancelamento' });

    return bot.editMessageText(
      `🗑️ Tarefa *#${taskId}* cancelada.\n\n💎 ${ton(task.reward)} devolvidos ao teu saldo.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: backBtn() }
    );
  }

  // ── Criar tarefa ─────────────────────────────────────────────
  if (data === 'menu_create') {
    const user = await getUser(userId);
    if (!user) return;
    if (parseFloat(user.ton_balance || 0) <= 0) {
      return bot.editMessageText(`❌ Saldo TON insuficiente.\n\nDeposita fundos primeiro.`, {
        chat_id: chatId, message_id: msgId,
        reply_markup: { inline_keyboard: [
          [{ text: '💰 Depositar', callback_data: 'menu_deposit' }],
          [{ text: '⬅️ Voltar',    callback_data: 'menu_back'    }],
        ]},
      });
    }
    wizards[chatId] = { step: 'title', data: {} };
    return bot.editMessageText(`➕ *Criar Tarefa* — Passo 1/4\n\n📝 Escreve o *título* da tarefa:`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: backBtn() });
  }
});

// ════════════════════════════════════════════════════════════════
//  WIZARD DE CRIAÇÃO DE TAREFA
// ════════════════════════════════════════════════════════════════
bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text   = msg.text?.trim();
  const wizard = wizards[chatId];

  if (!wizard || !text) return;

  if (wizard.step === 'title') {
    wizard.data.title = text;
    wizard.step = 'description';
    return bot.sendMessage(chatId, `➕ *Criar Tarefa* — Passo 2/4\n\n📄 Escreve a *descrição* (ou "-" para ignorar):`, { parse_mode: 'Markdown' });
  }

  if (wizard.step === 'description') {
    wizard.data.description = text === '-' ? null : text;
    wizard.step = 'reward';
    return bot.sendMessage(chatId, `➕ *Criar Tarefa* — Passo 3/4\n\n💎 Qual a *recompensa* em TON? (ex: 0.5)`, { parse_mode: 'Markdown' });
  }

  if (wizard.step === 'reward') {
    const reward = parseFloat(text.replace(',', '.'));
    if (isNaN(reward) || reward <= 0)
      return bot.sendMessage(chatId, `❌ Valor inválido. Escreve um número positivo (ex: 0.5)`);
    const user = await getUser(userId);
    if (!user || parseFloat(user.ton_balance || 0) < reward)
      return bot.sendMessage(chatId, `❌ Saldo insuficiente! Tens *${ton(user?.ton_balance)}* e a recompensa é *${reward} TON*.`, { parse_mode: 'Markdown' });
    wizard.data.reward = reward;
    wizard.step = 'deadline';
    return bot.sendMessage(chatId, `➕ *Criar Tarefa* — Passo 4/4\n\n⏰ Qual o *prazo*? (ex: "24h", "3 dias", "-" para sem prazo)`, { parse_mode: 'Markdown' });
  }

  if (wizard.step === 'deadline') {
    wizard.data.deadline = text === '-' ? null : text;
    delete wizards[chatId];

    const user = await getUser(userId);
    if (!user) return;

    const newBal = (parseFloat(user.ton_balance || 0) - wizard.data.reward).toFixed(6);
    await supabase.from('users').update({ ton_balance: newBal }).eq('id', user.id);

    const { data: task } = await supabase.from('tasks').insert({
      advertiser_id: user.id, title: wizard.data.title, description: wizard.data.description,
      reward: wizard.data.reward, deadline: wizard.data.deadline, status: 'open',
    }).select().single();

    await supabase.from('transactions').insert({ user_id: user.id, type: 'payment', amount: wizard.data.reward, task_id: task.id, note: 'Escrow para tarefa' });

    return bot.sendMessage(chatId,
      `🎉 *Tarefa criada!*\n\n🆔 ID: *#${task.id}*\n📝 ${task.title}\n💎 Recompensa: *${ton(task.reward)}* (escrow)\n⏰ Prazo: ${task.deadline || 'Sem prazo'}`,
      { parse_mode: 'Markdown', reply_markup: mainMenu() }
    );
  }
});

// ════════════════════════════════════════════════════════════════
//  AUTO-POLLING DE INVOICES (a cada 30s)
// ════════════════════════════════════════════════════════════════
setInterval(async () => {
  const { data: pending } = await supabase
    .from('deposit_invoices').select('*, users(telegram_id, ton_balance)').eq('status', 'pending');
  if (!pending) return;

  for (const inv of pending) {
    const status = await getInvoiceStatus(inv.invoice_id).catch(() => null);
    if (!status) continue;

    if (status === 'paid') {
      await supabase.from('deposit_invoices').update({ status: 'paid', paid_at: new Date() }).eq('invoice_id', inv.invoice_id);
      const newBal = (parseFloat(inv.users.ton_balance || 0) + parseFloat(inv.amount_ton)).toFixed(6);
      await supabase.from('users').update({ ton_balance: newBal }).eq('telegram_id', inv.users.telegram_id);
      await supabase.from('transactions').insert({ user_id: inv.user_id, type: 'deposit', amount: inv.amount_ton, note: `Depósito ${inv.amount_ton} TON via xRocket` });
      bot.sendMessage(inv.users.telegram_id, `✅ *Depósito confirmado!*\n\n💎 *${inv.amount_ton} TON* adicionados ao teu saldo.`, { parse_mode: 'Markdown', reply_markup: mainMenu() }).catch(() => null);
    }

    if (status === 'expired') {
      await supabase.from('deposit_invoices').update({ status: 'expired' }).eq('invoice_id', inv.invoice_id);
      bot.sendMessage(inv.users.telegram_id, `⏰ Invoice de *${inv.amount_ton} TON* expirou. Cria um novo depósito.`, { parse_mode: 'Markdown' }).catch(() => null);
    }
  }
}, 30_000);

// ════════════════════════════════════════════════════════════════
//  HTTP SERVER — recebe updates do Telegram via webhook
//  + health check em GET /
// ════════════════════════════════════════════════════════════════
const server = http.createServer((req, res) => {
  // Health check
  if (req.method === 'GET') {
    res.writeHead(200);
    return res.end('OK');
  }

  // Webhook do Telegram
  if (req.method === 'POST' && req.url === WEBHOOK_PATH) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const update = JSON.parse(body);
        bot.processUpdate(update);   // injeta o update nos handlers registados
      } catch (e) {
        console.error('Webhook parse error:', e.message);
      }
      res.writeHead(200);
      res.end('OK');
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, async () => {
  console.log(`🌐 Servidor HTTP a ouvir na porta ${PORT}`);

  if (!WEBHOOK_URL) {
    console.error('❌ WEBHOOK_URL e RENDER_EXTERNAL_URL nao definidos — webhook NAO registado.');
    console.error('   Define WEBHOOK_URL nas variaveis de ambiente do Render.');
    return;
  }

  console.log(`🔗 URL detectado: ${WEBHOOK_URL}`);

  // Regista o webhook no Telegram (idempotente — pode chamar varias vezes)
  try {
    await bot.setWebHook(`${WEBHOOK_URL}${WEBHOOK_PATH}`);
    console.log(`✅ Webhook registado: ${WEBHOOK_URL}${WEBHOOK_PATH}`);
  } catch (err) {
    console.error('❌ Erro ao registar webhook:', err.message);
  }
});

process.on('SIGINT',  async () => { await bot.deleteWebHook(); server.close(); process.exit(); });
process.on('SIGTERM', async () => { await bot.deleteWebHook(); server.close(); process.exit(); });

console.log('🤖 TaskMarket Bot iniciado com xRocket Payments! (modo webhook)');
