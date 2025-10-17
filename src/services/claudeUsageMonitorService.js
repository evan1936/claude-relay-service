const claudeAccountService = require('./claudeAccountService')
const redis = require('../models/redis')
const logger = require('../utils/logger')
const https = require('https')
const ProxyHelper = require('../utils/proxyHelper')
const config = require('../../config/config')

class ClaudeUsageMonitorService {
  constructor() {
    this.monitorTimeout = null
    this.isRunning = false
    this.BASE_INTERVAL = 20 * 60 * 1000 // 20分钟基础间隔（兜底）
    this.AFTER_RESET_MINUTES = 5 // 重置后5分钟触发
    this.RESET_THRESHOLD_MINUTES = 10 // 5小时窗口剩余少于10分钟时触发重置
  }

  // 🚀 启动监控服务
  start() {
    if (this.isRunning) {
      logger.warn('⚠️ Claude usage monitor service is already running')
      return
    }

    logger.info('🚀 Starting Claude usage monitor service...')
    this.isRunning = true

    // 立即执行一次并调度下一次
    this.runAndScheduleNext()

    logger.success('✅ Claude usage monitor service started (smart scheduling based on reset times)')
  }

  // 🛑 停止监控服务
  stop() {
    if (!this.isRunning) {
      logger.warn('⚠️ Claude usage monitor service is not running')
      return
    }

    if (this.monitorTimeout) {
      clearTimeout(this.monitorTimeout)
      this.monitorTimeout = null
    }

    this.isRunning = false
    logger.info('🛑 Claude usage monitor service stopped')
  }

  // 📊 更新所有账户的使用数据
  async updateAllAccountsUsage() {
    try {
      logger.info('📊 Starting scheduled usage update for all Claude accounts...')

      const accounts = await redis.getAllClaudeAccounts()
      let successCount = 0
      let skipCount = 0
      let initCount = 0 // 5小时窗口初始化计数
      let failureCount = 0

      for (const account of accounts) {
        // 只处理活跃的 OAuth 账户
        if (account.isActive !== 'true') {
          skipCount++
          continue
        }

        // 检查是否是 OAuth 账户
        const scopes = account.scopes && account.scopes.trim() ? account.scopes.split(' ') : []
        const isOAuth = scopes.includes('user:profile') && scopes.includes('user:inference')

        if (!isOAuth) {
          skipCount++
          continue
        }

        try {
          // 获取最新的使用数据
          const usageData = await claudeAccountService.fetchOAuthUsage(account.id)

          if (usageData) {
            // 更新到 Redis
            await claudeAccountService.updateClaudeUsageSnapshot(account.id, usageData)

            // 检查是否需要初始化5小时窗口
            if (usageData.five_hour) {
              const needsInit = await this.checkAndResetFiveHourWindow(
                account,
                usageData.five_hour
              )
              if (needsInit) {
                initCount++
              }
            }

            successCount++
            logger.debug(`✅ Updated usage for account: ${account.name}`)
          } else {
            failureCount++
            logger.warn(`⚠️ No usage data returned for account: ${account.name}`)
          }
        } catch (error) {
          failureCount++
          logger.warn(
            `❌ Failed to update usage for account ${account.name}:`,
            error.message
          )
        }

        // 添加延迟避免触发限流 (每个账户之间间隔1秒)
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }

      logger.info(
        `📊 Usage update completed: ${successCount} success, ${skipCount} skipped, ${initCount} initialized, ${failureCount} failed (Total: ${accounts.length})`
      )
    } catch (error) {
      logger.error('❌ Failed to update accounts usage:', error)
    }
  }

  // 🔄 检查并初始化5小时窗口
  async checkAndResetFiveHourWindow(account, fiveHourData) {
    try {
      // 💡 如果没有 resets_at，说明5小时窗口未激活，需要主动发起请求来激活
      if (!fiveHourData.resets_at) {
        logger.info(
          `📊 Account ${account.name} has no 5h window resets_at, triggering initialization request...`
        )

        const initSuccess = await this.triggerFiveHourInitialization(account)

        if (initSuccess) {
          logger.success(`✅ Successfully initialized 5h window for account: ${account.name}`)
          return true
        } else {
          logger.warn(`⚠️ Failed to initialize 5h window for account: ${account.name}`)
          return false
        }
      }

      // 如果有 resets_at，只记录即将过期的窗口（不主动消耗）
      const now = new Date()
      const resetsAt = new Date(fiveHourData.resets_at)
      const remainingMinutes = Math.floor((resetsAt.getTime() - now.getTime()) / (1000 * 60))

      if (remainingMinutes <= this.RESET_THRESHOLD_MINUTES) {
        const utilization = fiveHourData.utilization || 0
        const remainingQuota = Math.round((1 - utilization) * 100)

        logger.info(
          `⏰ Account ${account.name} 5h window expires in ${remainingMinutes} minutes (utilization: ${(utilization * 100).toFixed(1)}%, remaining: ${remainingQuota}%)`
        )
      }

      return false
    } catch (error) {
      logger.error(
        `❌ Error checking 5h window for account ${account.name}:`,
        error.message
      )
      return false
    }
  }

  // 🔥 触发5小时窗口初始化（复用claudeRelayService的请求方法）
  async triggerFiveHourInitialization(account) {
    try {
      logger.info(`🔄 Initializing 5h window for ${account.name}...`)

      // 复用 claudeRelayService 的请求逻辑
      const claudeRelayService = require('./claudeRelayService')

      // 获取有效的 OAuth access token（会自动刷新）
      const accessToken = await claudeAccountService.getValidAccessToken(account.id)
      if (!accessToken) {
        logger.warn(`⚠️ No valid token for ${account.name}`)
        return false
      }

      // 构造最小请求（消耗最少tokens）
      const requestBody = {
        model: 'claude-3-haiku-20240307',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Hi' }]
      }

      // 获取代理
      const proxyAgent = await claudeRelayService._getProxyAgent(account.id)

      // 使用 claudeRelayService 的 _makeClaudeRequest 方法
      const response = await claudeRelayService._makeClaudeRequest(
        requestBody,
        accessToken,
        proxyAgent,
        { 'user-agent': 'claude-relay-service/usage-monitor' }, // clientHeaders
        account.id,
        null, // onRequest callback
        {} // requestOptions
      )

      if (response.statusCode === 200) {
        const parsed = JSON.parse(response.body)
        logger.info(
          `✅ Init success for ${account.name} (${parsed.usage?.input_tokens || 0}/${parsed.usage?.output_tokens || 0} tokens)`
        )

        // 等待2秒后验证
        await new Promise((r) => setTimeout(r, 2000))

        const newUsage = await claudeAccountService.fetchOAuthUsage(account.id)
        if (newUsage?.five_hour?.resets_at) {
          await claudeAccountService.updateClaudeUsageSnapshot(account.id, newUsage)
          const resets = new Date(newUsage.five_hour.resets_at)
          logger.info(
            `📊 5h window for ${account.name}: ${(newUsage.five_hour.utilization * 100).toFixed(1)}%, resets=${resets.toISOString()}`
          )
          return true
        }
      } else {
        logger.error(
          `❌ Init failed for ${account.name}: HTTP ${response.statusCode}`,
          response.body.substring(0, 200)
        )
      }

      return false
    } catch (e) {
      logger.error(`❌ Init error for ${account.name}:`, e.message)
      return false
    }
  }

  // 🔄 执行更新并调度下一次
  async runAndScheduleNext() {
    try {
      // 执行更新
      await this.updateAllAccountsUsage()

      // 计算下一次执行时间
      const nextInterval = await this.calculateNextInterval()

      // 调度下一次执行
      if (this.isRunning) {
        this.monitorTimeout = setTimeout(() => {
          this.runAndScheduleNext()
        }, nextInterval)

        const nextTime = new Date(Date.now() + nextInterval)
        logger.info(
          `⏰ Next usage update scheduled at ${nextTime.toISOString()} (in ${Math.round(nextInterval / 60000)} minutes)`
        )
      }
    } catch (error) {
      logger.error('❌ Error in runAndScheduleNext:', error)
      // 出错时使用基础间隔重试
      if (this.isRunning) {
        this.monitorTimeout = setTimeout(() => {
          this.runAndScheduleNext()
        }, this.BASE_INTERVAL)
      }
    }
  }

  // ⏱️ 计算下一次执行间隔
  async calculateNextInterval() {
    try {
      const accounts = await redis.getAllClaudeAccounts()
      const now = Date.now()
      const resetTimes = []

      for (const account of accounts) {
        if (account.isActive !== 'true') continue

        // 获取账户的usage快照
        const usageSnapshot = await claudeAccountService.getClaudeUsageSnapshot(account.id)
        if (!usageSnapshot) continue

        // 收集5小时窗口重置时间
        if (usageSnapshot.five_hour?.resets_at) {
          const resetTime = new Date(usageSnapshot.five_hour.resets_at).getTime()
          // 在重置时间后5分钟触发
          const triggerTime = resetTime + this.AFTER_RESET_MINUTES * 60 * 1000
          if (triggerTime > now) {
            resetTimes.push({
              accountName: account.name,
              resetTime: triggerTime,
              windowType: '5h'
            })
          }
        }

        // 收集7天窗口重置时间
        if (usageSnapshot.seven_day?.resets_at) {
          const resetTime = new Date(usageSnapshot.seven_day.resets_at).getTime()
          const triggerTime = resetTime + this.AFTER_RESET_MINUTES * 60 * 1000
          if (triggerTime > now) {
            resetTimes.push({
              accountName: account.name,
              resetTime: triggerTime,
              windowType: '7d'
            })
          }
        }
      }

      // 找到最近的重置时间
      if (resetTimes.length > 0) {
        resetTimes.sort((a, b) => a.resetTime - b.resetTime)
        const nearest = resetTimes[0]
        const interval = nearest.resetTime - now

        // 如果最近的重置时间在20分钟内，使用它
        if (interval < this.BASE_INTERVAL) {
          logger.info(
            `📅 Next check scheduled for ${nearest.accountName} ${nearest.windowType} window reset (in ${Math.round(interval / 60000)} minutes)`
          )
          return Math.max(interval, 60000) // 最少1分钟
        }
      }

      // 否则使用基础间隔（20分钟）
      logger.info('📅 No upcoming resets, using base interval (20 minutes)')
      return this.BASE_INTERVAL
    } catch (error) {
      logger.error('❌ Error calculating next interval:', error)
      return this.BASE_INTERVAL
    }
  }

  // 📊 获取监控状态
  getStatus() {
    return {
      isRunning: this.isRunning,
      baseInterval: this.BASE_INTERVAL,
      afterResetMinutes: this.AFTER_RESET_MINUTES,
      resetThresholdMinutes: this.RESET_THRESHOLD_MINUTES
    }
  }
}

module.exports = new ClaudeUsageMonitorService()