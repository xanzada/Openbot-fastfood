<?php
// Максимально легкое подключение к ядру DLE
define('DATALIFEENGINE', true);
define('ROOT_DIR', dirname(__FILE__));
define('ENGINE_DIR', ROOT_DIR . '/engine');

// 1. СНАЧАЛА подключаем общий конфиг
require_once(ENGINE_DIR . '/data/config.php');

// 2. ПОТОМ подключаем КЛАСС базы данных (ИСПРАВЛЕНИЕ ТУТ)
require_once(ENGINE_DIR . '/classes/mysql.php');

// 3. И ТОЛЬКО ТЕПЕРЬ подключаем настройки БД (где вызывается $db = new db;)
require_once(ENGINE_DIR . '/data/dbconfig.php');

if (!isset($db)) {
    $db = new db;
}

header('Content-Type: application/json; charset=utf-8');

// === УМНЫЙ СБОР ДАННЫХ ===
$raw_input = file_get_contents('php://input');
$json_input = json_decode($raw_input, true);

$input = [];
if (is_array($json_input)) { $input = array_merge($input, $json_input); }
if (!empty($_POST)) { $input = array_merge($input, $_POST); }
if (!empty($_GET)) { $input = array_merge($input, $_GET); }

// Получаем токен из базы данных сайта
$sk_row = $db->super_query("SELECT setting_value FROM " . PREFIX . "_spa_settings WHERE setting_key = 'secret_key'");
$secret_token = ($sk_row && !empty($sk_row['setting_value'])) ? trim($sk_row['setting_value']) : '';

// Получаем токен от n8n
$received_token = trim((string)($input['token'] ?? $input['secret_key'] ?? ''));

if (empty($input) || $received_token === '' || $received_token !== $secret_token) {
    die(json_encode(['success' => false, 'error' => 'Доступ запрещен. Неверный токен.'], JSON_UNESCAPED_UNICODE));
}

// === 0. КОМАНДА: AI ҮШІН БЕЛСЕНДІ МӘЗІРДІ ОҚУ (dle_spa_items) ===
function spa_api_bool_value($value, $default = false) {
    if (is_bool($value)) return $value;
    if (is_numeric($value)) return ((int)$value) === 1;
    if (is_string($value)) {
        $normalized = strtolower(trim($value));
        if (in_array($normalized, ['1', 'true', 'yes', 'on'], true)) return true;
        if (in_array($normalized, ['0', 'false', 'no', 'off'], true)) return false;
    }
    return $default;
}

function spa_api_is_ai_provider_error($value) {
    $text = mb_strtolower(trim((string)$value), 'UTF-8');
    if ($text === '') return false;

    $provider_markers = [
        'googlegenerativeaierror',
        'generativelanguage.googleapis.com',
        'fallback analytics used',
        'resource_exhausted',
        '429 too many requests'
    ];
    foreach ($provider_markers as $marker) {
        if (mb_strpos($text, $marker, 0, 'UTF-8') !== false) return true;
    }

    return mb_strpos($text, '503 service unavailable', 0, 'UTF-8') !== false
        && (mb_strpos($text, 'high demand', 0, 'UTF-8') !== false || mb_strpos($text, 'model', 0, 'UTF-8') !== false);
}

function spa_api_time_to_minutes($value) {
    if (!is_string($value) || !preg_match('/^(\d{1,2})[:.](\d{2})$/', trim($value), $m)) {
        return null;
    }

    $hours = max(0, min(23, (int)$m[1]));
    $minutes = max(0, min(59, (int)$m[2]));
    return ($hours * 60) + $minutes;
}

function spa_api_within_work_hours($work_start, $work_end) {
    $start = spa_api_time_to_minutes($work_start);
    $end = spa_api_time_to_minutes($work_end);
    if ($start === null || $end === null) return true;

    $now = ((int)date('H')) * 60 + (int)date('i');
    if ($start === $end) return true;
    if ($end > $start) return $now >= $start && $now <= $end;

    return $now >= $start || $now <= $end;
}

function spa_api_table_columns($db, $table) {
    static $cache = [];
    if (isset($cache[$table])) return $cache[$table];

    $columns = [];
    $db->query("SHOW COLUMNS FROM " . $table);
    while ($row = $db->get_row()) {
        if (isset($row['Field'])) {
            $columns[$row['Field']] = true;
        }
    }

    $cache[$table] = $columns;
    return $columns;
}

function spa_api_existing_select($columns, $preferred) {
    $selected = [];
    foreach ($preferred as $column) {
        if (isset($columns[$column])) {
            $selected[] = $column;
        }
    }
    return $selected ? implode(', ', $selected) : 'id';
}

function spa_api_decode_items($value) {
    if (is_array($value)) return $value;
    $decoded = json_decode((string)$value, true);
    return is_array($decoded) ? $decoded : [];
}

function spa_api_phone_variants($phone) {
    $digits = preg_replace('/[^0-9]/', '', (string)$phone);
    if ($digits === '') return [];

    $variants = [$digits];
    $tail10 = strlen($digits) >= 10 ? substr($digits, -10) : '';
    if ($tail10 !== '') {
        $variants[] = $tail10;
        $variants[] = '7' . $tail10;
        $variants[] = '8' . $tail10;
    }

    if (strlen($digits) === 10) {
        $variants[] = '7' . $digits;
        $variants[] = '8' . $digits;
    }

    if (strlen($digits) === 11 && ($digits[0] === '7' || $digits[0] === '8')) {
        $variants[] = '7' . substr($digits, 1);
        $variants[] = '8' . substr($digits, 1);
    }

    return array_values(array_unique(array_filter($variants)));
}

function spa_api_phone_where($db, $column, $phone) {
    $variants = spa_api_phone_variants($phone);
    if (!$variants) return "1=0";

    $digits_column = "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE({$column}, '+', ''), ' ', ''), '-', ''), '(', ''), ')', ''), '.', '')";
    $safe_values = [];
    foreach ($variants as $variant) {
        $safe_values[] = "'" . $db->safesql($variant) . "'";
    }

    $conditions = [$digits_column . " IN (" . implode(',', $safe_values) . ")"];
    $tail10 = strlen($variants[0]) >= 10 ? substr($variants[0], -10) : '';
    if ($tail10 !== '') {
        $conditions[] = $digits_column . " LIKE '%" . $db->safesql($tail10) . "'";
    }

    return "(" . implode(" OR ", $conditions) . ")";
}

function spa_api_normalize_payment_details($value) {
    if (is_string($value)) {
        $decoded = json_decode($value, true);
        $value = is_array($decoded) ? $decoded : [];
    }
    if (!is_array($value)) return [];

    $details = [];
    foreach ($value as $item) {
        if (!is_array($item)) continue;

        $label = trim(strip_tags((string)($item['label'] ?? $item['name'] ?? '')));
        $payment_value = trim(strip_tags((string)($item['value'] ?? $item['number'] ?? $item['url'] ?? '')));

        if ($label === '' || $payment_value === '') continue;
        if (in_array($label, ['Название', 'название', 'Реквизит', 'реквизит'], true) && in_array($payment_value, ['Номер / ссылка', 'номер / ссылка', 'Номер/ссылка', 'номер/ссылка'], true)) continue;

        $details[] = [
            'label' => $label,
            'value' => $payment_value
        ];
    }

    return $details;
}

function spa_api_inactive_order_statuses() {
    return ['completed', 'cancelled', 'canceled', 'done', 'finished', 'closed', 'refunded'];
}

function spa_api_inactive_order_status_sql() {
    return "('" . implode("','", spa_api_inactive_order_statuses()) . "')";
}

function spa_api_active_order_status_condition($column = 'status') {
    return "({$column} IS NULL OR LOWER(TRIM({$column})) NOT IN " . spa_api_inactive_order_status_sql() . ")";
}

function spa_api_is_inactive_order_status($status) {
    return in_array(strtolower(trim((string)$status)), spa_api_inactive_order_statuses(), true);
}

function spa_api_public_order_payload($row) {
    if (!$row || !is_array($row)) return null;

    $payload = [];
    $scalar_fields = [
        'id', 'phone', 'status', 'total_price', 'address', 'comment', 'ai_comment',
        'bonus', 'persons', 'is_pickup', 'delivery_type', 'payment_method',
        'payment_status', 'amount_paid', 'sender_name', 'created_at', 'date',
        'date_added', 'updated_at', 'time', 'courier_name', 'courier_phone'
    ];

    foreach ($scalar_fields as $field) {
        if (array_key_exists($field, $row)) {
            $payload[$field] = $row[$field];
        }
    }

    $payload['items'] = array_key_exists('items', $row) ? spa_api_decode_items($row['items']) : [];
    $payload['items_count'] = count($payload['items']);

    return $payload;
}

function spa_api_fetch_order_context($db, $phone, $order_id = 0, $limit = 5) {
    $table = PREFIX . "_spa_orders";
    $columns = spa_api_table_columns($db, $table);
    $select = spa_api_existing_select($columns, [
        'id', 'phone', 'status', 'items', 'total_price', 'address', 'comment',
        'ai_comment', 'bonus', 'persons', 'is_pickup', 'delivery_type',
        'payment_method', 'payment_status', 'amount_paid', 'sender_name',
        'created_at', 'date', 'date_added', 'updated_at', 'time',
        'courier_name', 'courier_phone'
    ]);

    $safe_phone = $db->safesql($phone);
    $phone_where = spa_api_phone_where($db, 'phone', $phone);
    $order_id = (int)$order_id;
    $limit = max(1, min(10, (int)$limit));

    $active_order = null;
    if ($order_id > 0) {
        $row = null;
        if ($safe_phone !== '') {
            $owner_condition = " AND {$phone_where}";
            $row = $db->super_query("SELECT {$select} FROM {$table} WHERE id = '{$order_id}'{$owner_condition} LIMIT 1");
        }
        $active_order = spa_api_public_order_payload($row);
    } elseif ($safe_phone !== '') {
        $active_status_condition = spa_api_active_order_status_condition('status');
        $row = $db->super_query("SELECT {$select} FROM {$table} WHERE {$phone_where} AND {$active_status_condition} ORDER BY id DESC LIMIT 1");
        $active_order = spa_api_public_order_payload($row);
    }

    $recent_orders = [];
    if ($safe_phone !== '') {
        $db->query("SELECT {$select} FROM {$table} WHERE {$phone_where} ORDER BY id DESC LIMIT {$limit}");
        while ($row = $db->get_row()) {
            $payload = spa_api_public_order_payload($row);
            if ($payload) $recent_orders[] = $payload;
        }
    }

    return [
        'source' => 'dle_spa_orders',
        'active_order' => $active_order,
        'recent_orders' => $recent_orders
    ];
}

if (isset($input['action']) && $input['action'] === 'get_runtime_status') {
    $settings = [];
    $db->query("SELECT setting_key, setting_value FROM " . PREFIX . "_spa_settings");
    while ($row = $db->get_row()) {
        $settings[$row['setting_key']] = $row['setting_value'];
    }

    $kitchen_raw = isset($settings['kitchen_status']) ? trim((string)$settings['kitchen_status']) : '{}';
    $kitchen_status = json_decode($kitchen_raw, true);
    if (!is_array($kitchen_status)) {
        $kitchen_status = [];
    }
    $payment_details_source = $kitchen_status['payment_details'] ?? ($settings['payment_details'] ?? []);
    $payment_details = spa_api_normalize_payment_details($payment_details_source);
    $kitchen_status = array_merge([
        'wait_time' => 40,
        'is_emergency' => false,
        'delivery' => true,
        'pickup' => true,
        'reset_at' => 0,
        'payment_details' => $payment_details
    ], $kitchen_status);
    $kitchen_status['payment_details'] = $payment_details;

    $reset_at = isset($kitchen_status['reset_at']) ? (int)$kitchen_status['reset_at'] : 0;
    if ($reset_at > 0 && time() > $reset_at) {
        $kitchen_status = [
            'wait_time' => 40,
            'is_emergency' => false,
            'delivery' => true,
            'pickup' => true,
            'reset_at' => 0,
            'payment_details' => $payment_details
        ];
        $ks_json = $db->safesql(json_encode($kitchen_status, JSON_UNESCAPED_UNICODE));
        $db->query("REPLACE INTO " . PREFIX . "_spa_settings (setting_key, setting_value) VALUES ('kitchen_status', '{$ks_json}')");
        $reset_at = 0;
    }

    $delivery = spa_api_bool_value($kitchen_status['delivery'] ?? null, true);
    $pickup = spa_api_bool_value($kitchen_status['pickup'] ?? null, true);
    $is_emergency = spa_api_bool_value($kitchen_status['is_emergency'] ?? null, false);
    $wait_time = isset($kitchen_status['wait_time']) ? (int)$kitchen_status['wait_time'] : 0;
    $work_start = isset($settings['work_start']) ? trim((string)$settings['work_start']) : '';
    $work_end = isset($settings['work_end']) ? trim((string)$settings['work_end']) : '';
    $within_work_hours = spa_api_within_work_hours($work_start, $work_end);
    $has_service_channel = ($delivery || $pickup);
    $is_accepting_orders = (!$is_emergency && $within_work_hours && $has_service_channel);

    $closed_reason = '';
    if ($is_emergency) {
        $closed_reason = 'emergency_stop';
    } elseif (!$within_work_hours) {
        $closed_reason = 'outside_work_hours';
    } elseif (!$has_service_channel) {
        $closed_reason = 'service_channels_disabled';
    }

    echo json_encode([
        'success' => true,
        'source' => 'dle_spa_settings',
        'restaurant_id' => $settings['restaurant_instance'] ?? ($input['restaurant_id'] ?? 'default'),
        'server_time' => date('c'),
        'settings' => $settings,
        'work_start' => $work_start,
        'work_end' => $work_end,
        'within_work_hours' => $within_work_hours,
        'kitchen_status' => $kitchen_status,
        'payment_details' => $payment_details,
        'delivery' => $delivery,
        'pickup' => $pickup,
        'wait_time' => $wait_time,
        'free_delivery' => isset($settings['free_delivery']) ? (int)$settings['free_delivery'] : 0,
        'is_emergency' => $is_emergency,
        'reset_at' => $reset_at,
        'reset_at_iso' => $reset_at > 0 ? date('c', $reset_at) : '',
        'is_accepting_orders' => $is_accepting_orders,
        'closed_reason' => $closed_reason
    ], JSON_UNESCAPED_UNICODE);
    die();
}

if (isset($input['action']) && $input['action'] === 'get_order_context') {
    $phone = isset($input['phone']) ? preg_replace('/[^0-9]/', '', (string)$input['phone']) : '';
    $order_id = (int)($input['order_id'] ?? 0);
    $context = spa_api_fetch_order_context($db, $phone, $order_id, 5);

    echo json_encode([
        'success' => true,
        'source' => $context['source'],
        'phone' => $phone,
        'order_id' => $context['active_order']['id'] ?? 0,
        'status' => $context['active_order']['status'] ?? 'Нет активного заказа',
        'order' => $context['active_order'],
        'active_order' => $context['active_order'],
        'recent_orders' => $context['recent_orders']
    ], JSON_UNESCAPED_UNICODE);
    die();
}

if (isset($input['action']) && $input['action'] === 'get_menu_context') {
    $lang = (isset($input['lang']) && $input['lang'] === 'ru') ? 'ru' : 'kz';

    $categories = [];
    $db->query("SELECT id, name, name_kz FROM " . PREFIX . "_spa_categories ORDER BY sort ASC, id ASC");
    while ($row = $db->get_row()) {
        $cat_name = ($lang === 'kz' && !empty($row['name_kz'])) ? $row['name_kz'] : $row['name'];
        $categories[(int)$row['id']] = $cat_name;
    }

    $items = [];
    $db->query("SELECT id, category_id, name, name_kz, description, description_kz, composition, composition_kz, price, promo_price, label 
        FROM " . PREFIX . "_spa_items 
        WHERE is_active = 1 
        ORDER BY sort ASC, id DESC");

    while ($row = $db->get_row()) {
        $category_id = (int)$row['category_id'];
        $item_name = ($lang === 'kz' && !empty($row['name_kz'])) ? $row['name_kz'] : $row['name'];
        $item_desc = ($lang === 'kz' && !empty($row['description_kz'])) ? $row['description_kz'] : $row['description'];
        $item_comp = ($lang === 'kz' && !empty($row['composition_kz'])) ? $row['composition_kz'] : $row['composition'];

        $items[] = [
            'id' => (int)$row['id'],
            'category_id' => $category_id,
            'category_name' => $categories[$category_id] ?? '',
            'name' => $item_name,
            'description' => $item_desc,
            'composition' => $item_comp,
            'price' => (int)$row['price'],
            'promo_price' => (int)$row['promo_price'],
            'label' => $row['label']
        ];
    }

    echo json_encode([
        'success' => true,
        'source' => 'dle_spa_items',
        'lang' => $lang,
        'count' => count($items),
        'items' => $items
    ], JSON_UNESCAPED_UNICODE);
    die();
}

// === 1. КОМАНДА: ОБНОВИТЬ CRM-ЛИДА (ИИ Анализ диалогов) ===
if (isset($input['action']) && $input['action'] === 'update_crm') {
    
    // Безопасное извлечение телефона
    $phone = isset($input['phone']) ? preg_replace('/[^0-9]/', '', (string)$input['phone']) : '';
    $phone = $db->safesql($phone);
    
    // БРОНЕЖИЛЕТ ОТ 500 ОШИБКИ: Умная проверка типов (AI может прислать массив)
    $interest = isset($input['interest']) ? (is_scalar($input['interest']) ? trim((string)$input['interest']) : json_encode($input['interest'], JSON_UNESCAPED_UNICODE)) : '';
    $sales_stage = isset($input['sales_stage']) ? (is_scalar($input['sales_stage']) ? trim((string)$input['sales_stage']) : json_encode($input['sales_stage'], JSON_UNESCAPED_UNICODE)) : '';
    $psycho_analysis = isset($input['psycho_analysis']) ? (is_scalar($input['psycho_analysis']) ? trim((string)$input['psycho_analysis']) : json_encode($input['psycho_analysis'], JSON_UNESCAPED_UNICODE)) : '';

    $interest = $db->safesql($interest);
    $sales_stage = $db->safesql($sales_stage);
    $psycho_analysis = $db->safesql($psycho_analysis);

    if ($phone !== '') {
        $lead = $db->super_query("SELECT id FROM " . PREFIX . "_spa_bot_leads WHERE phone = '{$phone}' LIMIT 1");
        
        if ($lead) {
            $db->query("UPDATE " . PREFIX . "_spa_bot_leads SET 
                interest = '{$interest}', 
                sales_stage = '{$sales_stage}', 
                psycho_analysis = '{$psycho_analysis}',
                last_updated = NOW() 
                WHERE phone = '{$phone}'");
        } else {
            $db->query("INSERT INTO " . PREFIX . "_spa_bot_leads 
                (phone, interest, sales_stage, psycho_analysis, first_contact, last_updated) 
                VALUES 
                ('{$phone}', '{$interest}', '{$sales_stage}', '{$psycho_analysis}', NOW(), NOW())");
        }
        echo json_encode(['success' => true, 'message' => 'Данные лида обновлены']);
    } else {
        echo json_encode(['success' => false, 'error' => 'Не указан номер телефона']);
    }
    die();
}

// === 2. КОМАНДА: ДОБАВИТЬ КОММЕНТАРИЙ О ЧЕКЕ (статус НЕ меняем) ===
if (isset($input['action']) && ($input['action'] === 'add_payment_comment' || $input['action'] === 'update_status')) {
    $order_id = (int)($input['order_id'] ?? 0);
    $input_phone = isset($input['phone']) ? preg_replace('/[^0-9]/', '', (string)$input['phone']) : '';
    $amount_paid = isset($input['amount_paid']) ? (int)preg_replace('/[^0-9]/', '', (string)$input['amount_paid']) : 0;
    if ($input_phone === '') {
        echo json_encode(['success' => false, 'error' => 'Не указан номер телефона плательщика'], JSON_UNESCAPED_UNICODE);
        die();
    }

    // УМНАЯ CROSS-VALIDATION (Если n8n не смог точно определить номер заказа)
    if ($order_id <= 0 || strlen((string)$order_id) > 9) {
        if ($input_phone !== '') {
            // 1. СНАЧАЛА ИЩЕМ АКТИВНЫЙ ЗАКАЗ С ТОЧНЫМ СОВПАДЕНИЕМ СУММЫ (Самый безопасный путь)
            $phone_where = spa_api_phone_where($db, 'phone', $input_phone);
            $active_status_condition = spa_api_active_order_status_condition('status');
            $last_order = $db->super_query("SELECT id FROM " . PREFIX . "_spa_orders WHERE {$phone_where} AND total_price = '{$amount_paid}' AND {$active_status_condition} ORDER BY id DESC LIMIT 1");
            
            // 2. Если сумма не совпала, просто берем последний активный заказ этого клиента
            if (!$last_order) {
                $last_order = $db->super_query("SELECT id FROM " . PREFIX . "_spa_orders WHERE {$phone_where} AND {$active_status_condition} ORDER BY id DESC LIMIT 1");
            }
            
            if ($last_order) {
                $order_id = (int)$last_order['id'];
            }
        }
    }

    if ($order_id <= 0) {
        echo json_encode(['success' => false, 'error' => 'Не указан ID заказа или заказ не найден'], JSON_UNESCAPED_UNICODE);
        die();
    }

    $receipt_owner_condition = " AND " . spa_api_phone_where($db, 'phone', $input_phone);
    $order = $db->super_query("SELECT id, phone, status, comment FROM " . PREFIX . "_spa_orders WHERE id = '{$order_id}'{$receipt_owner_condition} LIMIT 1");

    if (!$order) {
        echo json_encode(['success' => false, 'error' => 'Заказ не найден'], JSON_UNESCAPED_UNICODE);
        die();
    }
    if (spa_api_is_inactive_order_status($order['status'] ?? '')) {
        echo json_encode(['success' => false, 'error' => 'Заказ уже закрыт'], JSON_UNESCAPED_UNICODE);
        die();
    }

    $sender_name = isset($input['sender_name']) ? trim(strip_tags((string)$input['sender_name'])) : '';
    $bank_name = isset($input['bank_name']) ? trim(strip_tags((string)$input['bank_name'])) : '';
    if ($bank_name !== '') {
        $bank_name = mb_substr($bank_name, 0, 80, 'UTF-8');
    }
    $receipt_text = isset($input['receipt_text']) ? trim(strip_tags((string)$input['receipt_text'])) : '';
    $receipt_url = isset($input['receipt_url']) ? trim(strip_tags((string)$input['receipt_url'])) : '';

    $identity_parts = [];
    if ($sender_name !== '') $identity_parts[] = "отправитель: {$sender_name}";
    if ($bank_name !== '') $identity_parts[] = "банк: {$bank_name}";

    $parts = [];
    if ($amount_paid > 0) $parts[] = "сумма: {$amount_paid}";
    $parts = array_merge($parts, $identity_parts);
    if ($receipt_text !== '') $parts[] = "текст: {$receipt_text}";
    if ($receipt_url !== '') $parts[] = "файл: {$receipt_url}";

    $ai_text = $receipt_text !== '' ? $receipt_text : (!empty($parts) ? implode(', ', $parts) : 'Чек на проверку');
    if ($receipt_text !== '' && !empty($identity_parts)) {
        $ai_text = trim($ai_text . "\n" . implode(', ', $identity_parts));
    }
    $ai_comment_safe = $db->safesql($ai_text);

    $db->query("UPDATE " . PREFIX . "_spa_orders SET ai_comment = '{$ai_comment_safe}' WHERE id = '{$order_id}'");

    $delivery_check = $db->super_query("SELECT ai_comment FROM " . PREFIX . "_spa_orders WHERE id = '{$order_id}' LIMIT 1");
    if (!$delivery_check || (string)($delivery_check['ai_comment'] ?? '') !== $ai_text) {
        echo json_encode(['success' => false, 'error' => 'Receipt delivery was not confirmed'], JSON_UNESCAPED_UNICODE);
        die();
    }
    $delivered_at = date('c');
    $delivery_id = 'receipt:' . $order_id . ':' . time();

    echo json_encode([
        'success' => true,
        'message' => "Комментарий о чеке добавлен к заказу #{$order_id}",
        'order_id' => $order_id,
        'status' => $order['status'],
        'status_changed' => false,
        'delivery_id' => $delivery_id,
        'delivered_at' => $delivered_at
    ], JSON_UNESCAPED_UNICODE);
    die();
}


// === 3. КОМАНДА: ПОЛУЧИТЬ ДАННЫЕ ЗА СЕГОДНЯ (ДЛЯ n8n CRON) ===
if (isset($input['action']) && $input['action'] === 'get_today_crm') {
    $date = isset($input['date']) ? $db->safesql(trim((string)$input['date'])) : date('Y-m-d');
    
    $inst_row = $db->super_query("SELECT setting_value FROM " . PREFIX . "_spa_settings WHERE setting_key = 'restaurant_instance'");
    $instance_id = ($inst_row && !empty($inst_row['setting_value'])) ? $inst_row['setting_value'] : 'default';
    
    $day_start = $db->safesql($date . ' 00:00:00');
    $day_end = $db->safesql($date . ' 23:59:59');
    
    $sql = "SELECT phone, interest, sales_stage, psycho_analysis 
            FROM " . PREFIX . "_spa_bot_leads 
            WHERE (last_updated BETWEEN '{$day_start}' AND '{$day_end}')
               OR (first_contact BETWEEN '{$day_start}' AND '{$day_end}')";

            
    $result = $db->query($sql);
    $data = [];
    while ($row = $db->get_row($result)) {
        $data[] = [
            'instance' => $instance_id,
            'sales_stage' => $row['sales_stage'],
            'interest' => $row['interest'],
            'psycho_analysis' => $row['psycho_analysis']
        ];
    }
    
    echo json_encode(['success' => true, 'data' => $data], JSON_UNESCAPED_UNICODE);
    die();
}

// === 4. КОМАНДА: СОХРАНИТЬ ЕЖЕДНЕВНУЮ ИИ-АНАЛИТИКУ (BI) ===
if (isset($input['action']) && $input['action'] === 'save_daily_analytics') {
    
    $restaurant_id = isset($input['restaurant_id']) ? $db->safesql(trim((string)$input['restaurant_id'])) : 'default';
    $report_date = isset($input['report_date']) ? $db->safesql(trim((string)$input['report_date'])) : date('Y-m-d');
    $date_added = date("Y-m-d H:i:s");
    
    // Жесткое приведение числовых типов (по совету друга)
    $total_chats = (int)($input['total_chats'] ?? 0);
    $intent_orders = (int)($input['intent_orders'] ?? 0);
    $intent_payments = (int)($input['intent_payments'] ?? 0);
    $total_complaints = (int)($input['total_complaints'] ?? 0);
    $total_canceled = (int)($input['total_canceled'] ?? 0);
    $escalated_tickets = (int)($input['escalated_tickets'] ?? 0);
    
    $conversion_rate = (float)($input['conversion_rate'] ?? 0);
    
    // Умная обработка строк (если n8n пришлет массив вместо строки, скрипт не упадет с 500 ошибкой)
    $top_complaints_tags = isset($input['top_complaints_tags']) ? $db->safesql(is_scalar($input['top_complaints_tags']) ? trim((string)$input['top_complaints_tags']) : json_encode($input['top_complaints_tags'], JSON_UNESCAPED_UNICODE)) : '';
    $cancellation_reasons = isset($input['cancellation_reasons']) ? $db->safesql(is_scalar($input['cancellation_reasons']) ? trim((string)$input['cancellation_reasons']) : json_encode($input['cancellation_reasons'], JSON_UNESCAPED_UNICODE)) : '';
    $popular_items = isset($input['popular_items']) ? $db->safesql(is_scalar($input['popular_items']) ? trim((string)$input['popular_items']) : json_encode($input['popular_items'], JSON_UNESCAPED_UNICODE)) : '';
    $avg_mood = isset($input['avg_mood']) ? $db->safesql(is_scalar($input['avg_mood']) ? trim((string)$input['avg_mood']) : json_encode($input['avg_mood'], JSON_UNESCAPED_UNICODE)) : '';
    $ai_daily_advice = isset($input['ai_daily_advice']) ? $db->safesql(is_scalar($input['ai_daily_advice']) ? trim((string)$input['ai_daily_advice']) : json_encode($input['ai_daily_advice'], JSON_UNESCAPED_UNICODE)) : '';
    $critical_alert_raw = isset($input['critical_alert']) ? (is_scalar($input['critical_alert']) ? trim((string)$input['critical_alert']) : json_encode($input['critical_alert'], JSON_UNESCAPED_UNICODE)) : '';
    // Ошибка/перегрузка Gemini — это состояние внешнего AI-провайдера, а не
    // критическая бизнес-проблема ресторана. Не показываем технический стек клиенту.
    if (spa_api_is_ai_provider_error($critical_alert_raw)) $critical_alert_raw = '';
    $critical_alert = $db->safesql($critical_alert_raw);

    // MySQL 8.0: ON DUPLICATE KEY UPDATE защищает от дублей при повторном срабатывании Cron
    $sql = "INSERT INTO " . PREFIX . "_spa_ai_analytics 
            (report_date, restaurant_id, total_chats, intent_orders, intent_payments, conversion_rate, total_complaints, top_complaints_tags, total_canceled, cancellation_reasons, popular_items, avg_mood, escalated_tickets, ai_daily_advice, critical_alert, date_added)
            VALUES 
            ('{$report_date}', '{$restaurant_id}', '{$total_chats}', '{$intent_orders}', '{$intent_payments}', '{$conversion_rate}', '{$total_complaints}', '{$top_complaints_tags}', '{$total_canceled}', '{$cancellation_reasons}', '{$popular_items}', '{$avg_mood}', '{$escalated_tickets}', '{$ai_daily_advice}', '{$critical_alert}', '{$date_added}')
            ON DUPLICATE KEY UPDATE
            total_chats = VALUES(total_chats),
            intent_orders = VALUES(intent_orders),
            intent_payments = VALUES(intent_payments),
            conversion_rate = VALUES(conversion_rate),
            total_complaints = VALUES(total_complaints),
            top_complaints_tags = VALUES(top_complaints_tags),
            total_canceled = VALUES(total_canceled),
            cancellation_reasons = VALUES(cancellation_reasons),
            popular_items = VALUES(popular_items),
            avg_mood = VALUES(avg_mood),
            escalated_tickets = VALUES(escalated_tickets),
            ai_daily_advice = VALUES(ai_daily_advice),
            critical_alert = VALUES(critical_alert),
            date_added = VALUES(date_added)";

    $db->query($sql);

    echo json_encode(['success' => true, 'message' => 'AI Analytics saved for ' . $report_date], JSON_UNESCAPED_UNICODE);
    die();
}

// === 5. КОМАНДА: ПРОВЕРКА СТАТУСА ЗАКАЗА (Для n8n) ===
if (isset($input['action']) && $input['action'] === 'check_status') {
    // Безопасное извлечение телефона
    $phone = isset($input['phone']) ? preg_replace('/[^0-9]/', '', (string)$input['phone']) : '';
    $phone = $db->safesql($phone);

    if ($phone !== '') {
        // Ищем ПОСЛЕДНИЙ заказ клиента в таблице dle_spa_orders
        $context = spa_api_fetch_order_context($db, $phone, 0, 5);
        $order = $context['active_order'];

        if ($order) {
            // Если заказ завершен или отменен, говорим боту, что активных заказов нет
            if (spa_api_is_inactive_order_status($order['status'] ?? '')) {
                echo json_encode([
                    'success' => true, 
                    'order_id' => 0, 
                    'order' => null,
                    'active_order' => null,
                    'recent_orders' => $context['recent_orders'],
                    'status' => 'Нет активного заказа'
                ], JSON_UNESCAPED_UNICODE);
            } else {
                // Если статус активный (pending, paid, delivery) - отдаем его ИИ
                echo json_encode([
                    'success' => true, 
                    'order_id' => $order['id'], 
                    'status' => $order['status'],
                    'order' => $order,
                    'active_order' => $order,
                    'recent_orders' => $context['recent_orders']
                ], JSON_UNESCAPED_UNICODE);
            }
        } else {
            // Если заказов вообще никогда не было
            echo json_encode([
                'success' => true, 
                'order_id' => 0, 
                'order' => null,
                'active_order' => null,
                'recent_orders' => $context['recent_orders'],
                'status' => 'Нет активного заказа'
            ], JSON_UNESCAPED_UNICODE);
        }
    } else {
        echo json_encode([
            'success' => false, 
            'error' => 'Не указан номер телефона'
        ], JSON_UNESCAPED_UNICODE);
    }
    die();
}

// === 6. ЖАҢА КОМАНДА: АДМИН ЧЕКТІ РАСТАП, БОТ/ПРИНТЕРГЕ СИГНАЛ БЕРУ ===
if (isset($input['action']) && $input['action'] === 'confirm_payment_and_print') {
    $order_id = (int)($input['order_id'] ?? 0);

    if ($order_id <= 0) {
        echo json_encode(['success' => false, 'error' => 'Заказ ID көрсетілмеді'], JSON_UNESCAPED_UNICODE);
        die();
    }

    $db->query("UPDATE " . PREFIX . "_spa_orders SET status = 'paid' WHERE id = '{$order_id}'");
    $order = $db->super_query("SELECT id, phone, items, total_price FROM " . PREFIX . "_spa_orders WHERE id = '{$order_id}' LIMIT 1");

    if ($order) {
        $payload = [
            'order_id' => $order['id'],
            'phone' => $order['phone'],
            'items' => json_decode($order['items'], true) ?? [],
            'total' => $order['total_price'],
            'status' => 'paid',
            'secret_token' => $secret_token 
        ];

        // 🚀 МАҢЫЗДЫ: 3000 порты ЖОҚ, таза HTTPS
        $nodejs_server_url = 'https://fastfood.bekaba.com/api/print_trigger'; 
        
        $ch = curl_init($nodejs_server_url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
        curl_setopt($ch, CURLOPT_TIMEOUT, 3);
        curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, false);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
        curl_exec($ch);
        curl_close($ch);

        echo json_encode([
            'success' => true, 
            'message' => 'Төлем расталды! Бот пен Принтерге сигнал кетті.'
        ], JSON_UNESCAPED_UNICODE);
    } else {
        echo json_encode(['success' => false, 'error' => 'Базадан тапсырыс табылмады'], JSON_UNESCAPED_UNICODE);
    }
    die();
}

// Заглушка, если n8n прислал неизвестную команду
echo json_encode(['success' => false, 'error' => 'Неизвестное действие']);
?>
