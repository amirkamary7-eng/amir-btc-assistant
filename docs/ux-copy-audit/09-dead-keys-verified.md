# Dead i18n Keys — Verified Registry (Task 75)

Date: 2026-10-12 | Branch: fix/ux-copy-remediation | Base: PR #83 head 4b25a4db

## Method

- Dictionary parsed from the REAL i18n.js via Node VM (1,435 FA keys, 1,435 EN keys, parity 100%).
- Usage corpus = 12 runtime files: app.js, admin.js, membership-user.js, membership-admin.js,
  referral.js, wallet.js, assistant.js, cosmetics.js, notifications.js, shared-utils.js, i18n-consumer checks, index.html.
- Static patterns: `t('key')`, `data-i18n`, `data-i18n-placeholder`, `data-i18n-aria-label`, `i18n.fa['key']`.
- Dynamic patterns traced (Task 71 method): month_*, forex_type_*, tier_+getTierKey, source_*, day_cycle_*,
  limit_*, trend_*, and every `t('prefix' + var)` concatenation. Keys sharing a live dynamic prefix are NOT dead.
- Spot-checked suspected false positives (welcome/referral/copy/share/copied/set_alert/current_price/tab_analysis/mem_err_*/alert_*):
  the raw-string hits are non-t() contexts (category: 'referral', RT-local dicts, execCommand). Confirmed dead.

## Result: 275 dead keys of 1435 (FA≡EN identical sets)

**No keys were deleted.** Removal is a separate, user-approved change (per Task 75 rules:
no text-search deletion; deletion must come after this registry is reviewed).

## Inventory by group

| Prefix | Count | Keys |
|---|---|---|
| adm | 127 | adm_logout_error, adm_error_prefix, adm_rc_error_short, adm_rc_opt_type_nft, adm_rc_th_category, adm_ads_status_draft, adm_ads_status_paused, adm_ads_status_archived, adm_ads_change_status, adm_ads_ch_mini_app, adm_ads_ch_telegram, adm_ads_aud_free … +115 more |
| ns | 26 | ns_smart_desc, ns_categories, ns_analysis, ns_analysis_desc, ns_calendar, ns_calendar_desc, ns_price_alert, ns_price_alert_desc, ns_market, ns_market_desc, ns_news, ns_news_desc … +14 more |
| join | 17 | join_vip_title, join_vip_desc, join_vip_btn, join_vip_hint, join_verify_btn, join_not_verified, join_verified, join_welcome, join_web_title, join_web_desc, join_open_bot, join_db_error … +5 more |
| alert | 10 | alert_target, alert_bot_hint, alert_registered, alert_above, alert_below, alert_breakout, alert_breakdown, alert_support_touch, alert_resistance_touch, alert_preset_ath |
| cal | 9 | cal_day_after, cal_past, cal_cpi, cal_fed, cal_pmi, cal_loading, cal_empty, cal_status_live, cal_status_upcoming |
| mem | 9 | mem_uid_label, mem_status_label, mem_actions_label, mem_vip, mem_err_duplicate_uid, mem_err_duplicate_request, mem_err_exchange_mismatch, mem_err_invalid_transition, mem_loading_module |
| forex | 8 | forex_cat_major, forex_cat_cross, forex_cat_metal, forex_cat_stock, forex_group_metal, forex_group_major, forex_group_cross, forex_group_stock |
| tf | 7 | tf_1m, tf_5m, tf_15m, tf_1h, tf_4h, tf_1d, tf_1w |
| hero | 5 | hero_badge, hero_desc, hero_cta, hero_cta_trade, hero_cta_analysis |
| share | 3 | share, share_direct, share_ref_text |
| ai | 3 | ai_messages_today, ai_cooldown, ai_limit |
| dashboard | 3 | dashboard_featured_analysis, dashboard_view_detail, dashboard_btc_dominance |
| heatmap | 3 | heatmap_subtitle, heatmap_top, heatmap_show_more |
| af | 3 | af_support_opt, af_current_price_opt, af_resistance_opt |
| copy | 2 | copy, copy_ref_msg |
| news | 2 | news_economy, news_unavailable |
| watchlist | 2 | watchlist_limit, watchlist_limit_premium |
| no | 2 | no_analysis_list, no_news |
| ref | 2 | ref_wheel, ref_wheel_desc |
| about | 2 | about_version, about_desc |
| top | 2 | top_gainers, top_losers |
| price | 2 | price, price_reached |
| toast | 2 | toast_analysis_save_error_detail, toast_unexpected_error |
| welcome | 1 | welcome |
| referral | 1 | referral |
| set | 1 | set_alert |
| current | 1 | current_price |
| tab | 1 | tab_top_market |
| analysis | 1 | analysis_title |
| new | 1 | new_analysis |
| section | 1 | section_analysis |
| edit | 1 | edit_analysis |
| update | 1 | update_analysis |
| chart | 1 | chart_unavailable |
| coming | 1 | coming_soon |
| official | 1 | official_channel |
| summary | 1 | summary_btc_dom |
| market | 1 | market_sentiment |
| change | 1 | change_24h |
| mcap | 1 | mcap |
| copied | 1 | copied |
| online | 1 | online_users |
| delete | 1 | delete_account_success |
| decision | 1 | decision_range |
| resistance | 1 | resistance |
| support | 1 | support_level |
| mkt | 1 | mkt_search_ph |

## Full flat list

```
welcome
referral
copy
share
share_direct
set_alert
alert_target
alert_bot_hint
alert_registered
alert_above
alert_below
alert_breakout
alert_breakdown
alert_support_touch
alert_resistance_touch
current_price
tab_top_market
analysis_title
new_analysis
news_economy
hero_badge
hero_desc
hero_cta
section_analysis
watchlist_limit
watchlist_limit_premium
no_analysis_list
no_news
news_unavailable
join_vip_title
join_vip_desc
join_vip_btn
join_vip_hint
join_verify_btn
join_not_verified
join_verified
join_welcome
join_web_title
join_web_desc
join_open_bot
join_db_error
join_lock_title
join_lock_desc
join_lock_channel_btn
join_lock_verify_btn
join_lock_bot_btn
edit_analysis
update_analysis
share_ref_text
chart_unavailable
coming_soon
ref_wheel
ref_wheel_desc
cal_day_after
cal_past
cal_cpi
cal_fed
cal_pmi
cal_loading
cal_empty
about_version
about_desc
official_channel
summary_btc_dom
market_sentiment
top_gainers
top_losers
price
change_24h
mcap
tf_1m
tf_5m
tf_15m
tf_1h
tf_4h
tf_1d
tf_1w
copied
copy_ref_msg
online_users
cal_status_live
cal_status_upcoming
price_reached
ai_messages_today
ai_cooldown
ai_limit
ns_smart_desc
ns_categories
ns_analysis
ns_analysis_desc
ns_calendar
ns_calendar_desc
ns_price_alert
ns_price_alert_desc
ns_market
ns_market_desc
ns_news
ns_news_desc
ns_referral
ns_referral_desc
ns_reward
ns_reward_desc
ns_ticket
ns_ticket_desc
ns_system
ns_system_desc
ns_marketing_desc
ns_sub_title
ns_sub_desc
ns_sub_activate
ns_active
ns_inactive
dashboard_featured_analysis
dashboard_view_detail
dashboard_btc_dominance
hero_cta_trade
hero_cta_analysis
delete_account_success
alert_preset_ath
heatmap_subtitle
heatmap_top
heatmap_show_more
toast_analysis_save_error_detail
toast_unexpected_error
decision_range
resistance
support_level
forex_cat_major
forex_cat_cross
forex_cat_metal
forex_cat_stock
forex_group_metal
forex_group_major
forex_group_cross
forex_group_stock
af_support_opt
af_current_price_opt
af_resistance_opt
mkt_search_ph
adm_logout_error
adm_error_prefix
mem_uid_label
mem_status_label
mem_actions_label
mem_vip
mem_err_duplicate_uid
mem_err_duplicate_request
mem_err_exchange_mismatch
mem_err_invalid_transition
mem_loading_module
adm_rc_error_short
adm_rc_opt_type_nft
adm_rc_th_category
adm_ads_status_draft
adm_ads_status_paused
adm_ads_status_archived
adm_ads_change_status
adm_ads_ch_mini_app
adm_ads_ch_telegram
adm_ads_aud_free
adm_ads_aud_premium
adm_ads_img_size_err
adm_ads_img_format_err
adm_ads_img_uploading
adm_ads_img_uploaded
adm_ads_img_upload_err
adm_ads_img_upload_err_prefix
adm_ads_img_read_err
adm_ads_yes_short
adm_ads_no_short
adm_ads_order_label
adm_ads_channels_intro
adm_ads_channels_title
adm_ads_add_channel
adm_ads_channels_empty_title
adm_ads_add_first_channel
adm_ads_no_data_received
adm_ads_channels_load_err
adm_ads_new_channel_title
adm_ads_field_username
adm_ads_field_channel_title
adm_ads_field_join_url
adm_ads_field_display_order
adm_ads_field_campaign_status
adm_ads_field_show
adm_ads_show_active
adm_ads_create_channel_btn
adm_ads_channel_not_found
adm_ads_edit_channel_title
adm_ads_join_url_err
adm_ads_saving
adm_ads_channel_updated
adm_ads_channel_created
adm_ads_save_error_prefix
adm_ads_delete_confirm
adm_ads_channel_deleted
adm_ads_delete_error
adm_ads_status_change_error
adm_ads_cooldown_tag
adm_ads_last_change_tag
adm_ads_popups_intro
adm_ads_popups_title
adm_ads_add_popup
adm_ads_popups_empty_title
adm_ads_add_first_popup
adm_ads_popups_load_err
adm_ads_edit_popup_title
adm_ads_new_popup_title
adm_ads_create_popup_btn
adm_ads_field_btn_text
adm_ads_field_btn_url
adm_ads_field_image_optional
adm_ads_field_image
adm_ads_select_image
adm_ads_img_hint
adm_ads_popup_not_found
adm_ads_title_required
adm_ads_popup_updated
adm_ads_popup_created
adm_ads_delete_popup_confirm
adm_ads_popup_deleted
adm_ads_messages_intro
adm_ads_messages_title
adm_ads_add_message
adm_ads_messages_empty_title
adm_ads_add_first_message
adm_ads_messages_load_err
adm_ads_edit_message_title
adm_ads_new_message_title
adm_ads_create_message_btn
adm_ads_field_destination
adm_ads_field_audience
adm_ads_aud_free_label
adm_ads_aud_premium_label
adm_ads_aud_all_label
adm_ads_message_not_found
adm_ads_msg_title_required
adm_ads_msg_body_required
adm_ads_message_updated
adm_ads_message_created
adm_ads_delete_message_confirm
adm_ads_message_deleted
adm_ads_send_message_intro
adm_ads_sending
adm_ads_send_no_users
adm_ads_send_success
adm_ads_send_recent
adm_ads_send_duplicate
adm_ads_send_error_prefix
adm_ads_send_error
adm_vpn_no_data
adm_vpn_status_pending
adm_vpn_status_fulfilled
adm_vpn_status_cancelled
adm_vpn_status_failed
adm_vpn_duration_month
adm_vpn_duration_week
adm_vpn_send_link_btn
adm_vpn_sent_pill
adm_vpn_send_modal_title
adm_vpn_modal_user
adm_vpn_modal_plan
adm_vpn_modal_cost
adm_vpn_modal_credit
adm_vpn_modal_tracking
adm_vpn_modal_link_label
adm_vpn_send_to_user_btn
adm_vpn_link_invalid
adm_vpn_send_confirm
adm_vpn_send_failed
adm_vpn_send_failed_pending
adm_vpn_communication_error
adm_th_status
adm_th_actions
adm_health_overall_label
```
