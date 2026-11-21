/* 电机模块：方向识别、换向死区、占空比平滑与堵转过流保护。
 * 时间基准统一为 MyTimer_GetTick100us() 的 100us tick，前台由应用层每轮轮询调用一次。
 * 引脚：P23/F-R 读方向请求（高电平正转），P16/P17 控制 IN1/IN2，EPWM3/EPWM4 输出调速波形。
 * 模块边界：不直接访问 ADC 寄存器，堵转判断接收应用层传入的 SC 原始样本。
 * 判断风格：条件统一写成“等于期望值”的正向形式（== 具体值），不使用反向比较。
 */
#include "my_motor.h"
#include "my_timer.h"
#include "cms8s6990.h"
#include "epwm.h"

/* 时间参数与状态常量：tick 为 100us，注释里同时给出换算后的物理时间。 */
/* FR 方向请求去抖时间：电平连续保持 200 tick = 20 ms 才认为可信。 */
#define MY_MOTOR_FR_DEBOUNCE_TICKS 200UL
/* 换向死区：桥臂关闭后至少等待 200 tick = 20 ms 才允许另一方向开通。 */
#define MY_MOTOR_DIRECTION_DEADTIME_TICKS 200UL
/* 两路 PWM 通道掩码：EPWM3/EPWM4 使用同一比较值，各驱动一个桥臂。 */
#define MY_MOTOR_PWM_CHANNELS (EPWM_CH_3_MSK | EPWM_CH_4_MSK)
/* PWM 周期计数：600 个计数配合 2 分频得到 20 kHz，即 50 us 一个周期。 */
#define MY_MOTOR_PWM_PERIOD_COUNTS 600U
/* 上电默认目标占空比 60%；业务层通过 MyMotor_RequestDutyPercent() 改写。 */
#define MY_MOTOR_PWM_DUTY_PERCENT 60U
/* 周期寄存器值取“计数 - 1”，与 EPWM 向下计数方式的自动重载语义一致。 */
#define MY_MOTOR_PWM_PERIOD (MY_MOTOR_PWM_PERIOD_COUNTS - 1U)
/* motor_state 取值：0 停止（桥臂全关）；1 正转；2 反转；3 堵转刹车（双臂导通）。 */
#define MY_MOTOR_STOPPED 0U
#define MY_MOTOR_FORWARD 1U
#define MY_MOTOR_REVERSE 2U
#define MY_MOTOR_BRAKED 3U
/* 占空比步进间隔：500 tick = 50 ms 调整 1 个百分点，避免电流突变。 */
#define MY_MOTOR_DUTY_STEP_INTERVAL_TICKS 500UL
/* 堵转电流阈值：10 centiamps = 0.10 A（按 7.50 A 满量程折算）。 */
#define MY_MOTOR_STALL_THRESHOLD_CENTIAMPS 10U
/* 过流确认时间：连续超过阈值 1000 tick = 100 ms 才判定堵转。 */
#define MY_MOTOR_STALL_CONFIRM_TICKS 1000UL
/* 启动宽限期：方向开通后 5000 tick = 500 ms 内不判堵转，避开启动冲击电流。 */
#define MY_MOTOR_STALL_STARTUP_GRACE_TICKS 5000UL
/* 占空比稳定期：最后一次调整后 5000 tick = 500 ms 内不判堵转。 */
#define MY_MOTOR_STALL_SETTLE_TICKS 5000UL

/* 方向去抖与换向状态。 */
/* FR 候选电平的变化起点，作为去抖计时基准。 */
static unsigned long fr_candidate_since_ticks;
/* 桥臂关闭时刻，作为换向死区计时基准。 */
static unsigned long direction_off_since_ticks;
/* 最近一次读到的 FR 电平（0/1），尚未去抖。 */
static unsigned char fr_candidate_level;
/* 去抖后的稳定 FR 电平，用来解码请求方向。 */
static unsigned char fr_stable_level;
/* 是否已取得首个稳定电平：0 表示还在首次去抖，1 表示后续按稳定值运行。 */
static unsigned char fr_stable_valid;
/* 当前电机状态：MY_MOTOR_STOPPED/FORWARD/REVERSE/BRAKED。 */
static unsigned char motor_state;
/* 死区结束后要施加的方向；STOPPED 表示尚未确定。 */
static unsigned char pending_direction;
/* 已收到可执行方向请求：FR 正在消抖时清零，防止重新开通旧方向。 */
static unsigned char direction_request_valid;

/* 占空比平滑状态。 */
/* 上一次占空比调整时刻，用于限制步进频率。 */
static unsigned long duty_step_ticks;
/* 当前实际占空比，非 static：业务/应用层通过 MY_MOTOR_DUTY_PERCENT() 只读查询。 */
unsigned char motor_duty_percent;
/* 目标占空比，由 MyMotor_RequestDutyPercent() 宏设置。 */
unsigned char motor_target_duty_percent;

/* 过流与堵转保护状态。 */
/* 本次方向开通时刻，用于启动宽限期判断。 */
static unsigned long direction_started_ticks;
/* 连续过流的起始时刻，配合确认时间判断堵转。 */
static unsigned long stall_overcurrent_since_ticks;
/* 过流计时进行中标志：1 表示已记录起始时刻，正在累计。 */
static unsigned char stall_overcurrent_active;
/* 堵转锁定标志：1 表示已刹车锁定，只接受稳定反向请求解锁。 */
static unsigned char stall_locked;
/* 锁定时电机所处的方向，用于判断解锁请求是否真的反向。 */
static unsigned char stall_locked_direction;

/* 关闭桥臂：P16/P17 恢复普通 GPIO 输出并清零，使 IN1/IN2 同时无效。
 * 停车、换向和锁定前都走这一步，保证进入死区时上下桥都已关断。
 */
static void MyMotor_DisableBridge(void) {
	P16CFG = 0x00U;
	P17CFG = 0x00U;
	P16 = 0U;
	P17 = 0U;
}

/* 每 50 ms 将实际占空比向目标推进 1%，并同步更新两路 PWM。 */
static void MyMotor_UpdateDuty(unsigned long now_ticks) {
	unsigned int compare_value;

	if (stall_locked == 1U) {
		return;
	}
	if (motor_duty_percent == motor_target_duty_percent) {
		return;
	}
	if ((unsigned long)(now_ticks - duty_step_ticks) < MY_MOTOR_DUTY_STEP_INTERVAL_TICKS) {
		return;
	}
	if (motor_duty_percent < motor_target_duty_percent) {
		motor_duty_percent++;
	} else {
		motor_duty_percent--;
	}
	duty_step_ticks = now_ticks;
	if (motor_duty_percent == 0U) {
		compare_value = 0U;
	} else {
		compare_value = (unsigned int)((MY_MOTOR_PWM_PERIOD_COUNTS * motor_duty_percent) / 100U) - 1U;
	}
	EPWM_ConfigChannelSymDuty(EPWM3, compare_value);
	EPWM_ConfigChannelSymDuty(EPWM4, compare_value);
}

/* 模块初始化：引脚方向、EPWM 时基与周期、各状态变量初值。
 * 初始化阶段先保持桥臂关闭，PWM 以 0% 启动，等 FR 去抖出稳定方向后再开通。
 * 目标占空比置为默认 60%，实际输出由 MyMotor_UpdateDuty() 逐步爬升。
 */
void MyMotor_Init(void) {
	/* 先把三个相关引脚恢复为普通 GPIO，避免复用功能在配置过程中产生毛刺。 */
	P16CFG = 0x00U;
	P17CFG = 0x00U;
	P23CFG = 0x00U;
	/* P23 作为 FR 输入：使能内部上拉，并设为输入方向；P16/P17 设为输出。 */
	P2UP |= 0x08U;
	MyMotor_DisableBridge();
	P1TRIS |= 0xC0U;
	P2TRIS &= (unsigned char)~0x08U;
	/* EPWM：向下计数 + 对称输出 + 独立波形/输出控制，两路通道时钟统一 2 分频。 */
	EPWM_ConfigRunMode(EPWM_COUNT_DOWN | EPWM_OCU_SYMMETRIC |
		EPWM_WFG_INDEPENDENT | EPWM_OC_INDEPENDENT);
	EPWM_ConfigChannelClk(EPWM3, EPWM_CLK_DIV_2);
	EPWM_ConfigChannelClk(EPWM4, EPWM_CLK_DIV_2);
	/* 使能自动重载，周期寄存器写“计数 - 1”，比较值先置 0 保证上电无输出。 */
	EPWM_EnableAutoLoadMode(MY_MOTOR_PWM_CHANNELS);
	EPWM_ConfigChannelPeriod(EPWM3, MY_MOTOR_PWM_PERIOD);
	EPWM_ConfigChannelPeriod(EPWM4, MY_MOTOR_PWM_PERIOD);
	EPWM_ConfigChannelSymDuty(EPWM3, 0U);
	EPWM_ConfigChannelSymDuty(EPWM4, 0U);
	/* 运行状态初值：实际占空比从 0 起步，目标为默认 60%。 */
	motor_duty_percent = 0U;
	motor_target_duty_percent = MY_MOTOR_PWM_DUTY_PERCENT;
	duty_step_ticks = MyTimer_GetTick100us();
	direction_started_ticks = duty_step_ticks;
	/* 堵转保护状态复位，上电不处于锁定状态。 */
	stall_overcurrent_since_ticks = 0UL;
	stall_overcurrent_active = 0U;
	stall_locked = 0U;
	stall_locked_direction = MY_MOTOR_STOPPED;
	direction_request_valid = 0U;
	/* 输出不反相，开启输出并启动计数；此时占空比为 0，电机仍不转。 */
	PWMPINV &= (unsigned char)~MY_MOTOR_PWM_CHANNELS;
	EPWM_EnableOutput(MY_MOTOR_PWM_CHANNELS);
	EPWM_Start(MY_MOTOR_PWM_CHANNELS);
	/* FR 候选值直接取当前电平（引脚为高则候选 1，否则候选 0），但标记为尚未稳定，首轮需重新去抖。 */
	fr_candidate_level = (P23 == 0U) ? 0U : 1U;
	fr_stable_level = fr_candidate_level;
	fr_stable_valid = 0U;
	motor_state = MY_MOTOR_STOPPED;
	pending_direction = MY_MOTOR_STOPPED;
	fr_candidate_since_ticks = MyTimer_GetTick100us();
	direction_off_since_ticks = fr_candidate_since_ticks;
}

/* 堵转刹车：占空比归零、关闭 PWM 输出，并让 P16/P17 同时为高电平实现动态刹车。
 * 同时记录当前方向并置锁定标志，之后不再自动重启，只接受稳定的反向 FR 请求解锁。
 */
static void MyMotor_ApplyStallBrake(void) {
	/* 先停止调速输出，再把两个桥臂同时拉高，避免刹车过程中仍有 PWM 占空。 */
	motor_duty_percent = 0U;
	EPWM_ConfigChannelSymDuty(EPWM3, 0U);
	EPWM_ConfigChannelSymDuty(EPWM4, 0U);
	P1 |= 0xC0U;
	EPWM_DisableOutput(MY_MOTOR_PWM_CHANNELS);
	P16CFG = 0x00U;
	P17CFG = 0x00U;
	P16 = 1U;
	P17 = 1U;
	/* 记录锁定方向与锁定状态，供方向机理解锁判断使用。 */
	stall_locked_direction = motor_state;
	stall_locked = 1U;
	stall_overcurrent_active = 0U;
	direction_request_valid = 0U;
	motor_state = MY_MOTOR_BRAKED;
}

/* 每个 SC_READY 事件调用一次：用最新 SC 采样判断是否堵转。
 * 依次过滤：已锁定或未在运行、仍在启动宽限期、占空比未到目标或刚调整过、电流低于阈值。
 * 电流换算沿用 ADC 满量程 7.50 A 的线性系数，结果单位为 0.01 A。
 * 首次超阈值只记录起始时刻，连续超过 100 ms 才执行刹车锁定。
 */
void MyMotor_UpdateCurrentSample(unsigned int sc_sample_raw) {
	unsigned long now_ticks;
	unsigned int current_centiamps;
	unsigned char running;
	unsigned char duty_matched;

	/* 运行标志：正转为 1、反转为 1，停止或刹车为 0。 */
	running = (unsigned char)((motor_state == MY_MOTOR_FORWARD) ||
		(motor_state == MY_MOTOR_REVERSE));
	/* 已锁定（stall_locked == 1）或未在运行（running == 0）：清过流计时，避免无效累计。 */
	if (stall_locked == 1U || running == 0U) {
		stall_overcurrent_active = 0U;
		return;
	}
	now_ticks = MyTimer_GetTick100us();
	/* 启动宽限期：方向开通不足 500 ms，启动电流较大，不参与堵转判断。 */
	if ((unsigned long)(now_ticks - direction_started_ticks) < MY_MOTOR_STALL_STARTUP_GRACE_TICKS) {
		stall_overcurrent_active = 0U;
		return;
	}
	/* 占空比是否已等于目标：1 表示输出已稳定在目标值上。 */
	duty_matched = (unsigned char)((motor_duty_percent == motor_target_duty_percent) ? 1U : 0U);
	/* 占空比为 0、仍在步进（duty_matched == 0），或最近一次调整不足 500 ms：电流仍在变化。 */
	if (motor_duty_percent == 0U || duty_matched == 0U ||
		(unsigned long)(now_ticks - duty_step_ticks) < MY_MOTOR_STALL_SETTLE_TICKS) {
		stall_overcurrent_active = 0U;
		return;
	}
	/* 12 位原始值换算为 0.01 A：raw*750 满量程 7.50 A，加 2047 后除 4095 实现四舍五入。 */
	current_centiamps = (unsigned int)(((unsigned long)sc_sample_raw * 750UL + 2047UL) / 4095UL);
	/* 低于阈值：判定为正常负载，清除过流计时。 */
	if (current_centiamps < MY_MOTOR_STALL_THRESHOLD_CENTIAMPS) {
		stall_overcurrent_active = 0U;
		return;
	}
	/* 首次超阈值（stall_overcurrent_active == 0）只记录起点；计时中且累计满 100 ms 才确认堵转并刹车。 */
	if (stall_overcurrent_active == 0U) {
		stall_overcurrent_since_ticks = now_ticks;
		stall_overcurrent_active = 1U;
	} else if ((unsigned long)(now_ticks - stall_overcurrent_since_ticks) >= MY_MOTOR_STALL_CONFIRM_TICKS) {
		MyMotor_ApplyStallBrake();
	}
}

/* 直接完成 FR 采样、消抖、反向解锁、换向死区和桥臂开通。 */
static void MyMotor_UpdateDirection(unsigned long now_ticks) {
	unsigned char fr_level;
	unsigned char running;
	unsigned char requested_direction;
	unsigned char unlock_direction;

	/* 读取 FR 输入并归一化为 0/1；MY_MOTOR_FR_FORWARD_LEVEL 对应正转。 */
	fr_level = (P23 == 0U) ? 0U : 1U;
	/* 候选电平一旦变化，就从当前时刻重新开始 20 ms 去抖计时。 */
	if ((fr_level ^ fr_candidate_level) == 1U) {
		fr_candidate_level = fr_level;
		fr_candidate_since_ticks = now_ticks;
		/* 未锁定时，运行中的 FR 请求变化会立即关桥，不等待去抖结束才停止。 */
		if (stall_locked == 0U) {
			running = (unsigned char)((motor_state == MY_MOTOR_FORWARD) ||
				(motor_state == MY_MOTOR_REVERSE));
			if (running == 1U) {
				MyMotor_DisableBridge();
				motor_state = MY_MOTOR_STOPPED;
				/* 死区从实际关桥时刻起算；新的方向确认后仍须等待完整死区。 */
				direction_off_since_ticks = now_ticks;
			}
			/* 去抖期间请求无效，防止状态机重新应用先前缓存的旧方向。 */
			direction_request_valid = 0U;
		}
	}
	/* 堵转锁定期间保持刹车，只检查去抖后的 FR 是否请求相反方向。 */
	if (stall_locked == 1U) {
		/* 候选值仍不同于稳定值且已持续满去抖时间，才更新稳定输入。 */
		if ((fr_candidate_level ^ fr_stable_level) == 1U &&
			(unsigned long)(now_ticks - fr_candidate_since_ticks) >= MY_MOTOR_FR_DEBOUNCE_TICKS) {
			fr_stable_level = fr_candidate_level;
			requested_direction = (fr_stable_level == MY_MOTOR_FR_FORWARD_LEVEL) ?
				MY_MOTOR_FORWARD : MY_MOTOR_REVERSE;
			/* 解锁方向取堵转前方向的反向；同向请求不清除锁定。 */
			unlock_direction = (stall_locked_direction == MY_MOTOR_FORWARD) ?
				MY_MOTOR_REVERSE : MY_MOTOR_FORWARD;
			if (requested_direction == unlock_direction) {
				MyMotor_DisableBridge();
				/* 恢复 PWM 外设输出能力，但当前分支不会在本轮直接开通电机桥臂。 */
				EPWM_EnableOutput(MY_MOTOR_PWM_CHANNELS);
				/* 清除锁定并回到 STOPPED，后续由普通死区判断重新开通。 */
				stall_locked = 0U;
				stall_locked_direction = MY_MOTOR_STOPPED;
				motor_state = MY_MOTOR_STOPPED;
				pending_direction = requested_direction;
				direction_off_since_ticks = now_ticks;
				/* 解锁时重新计启动宽限期，避免旧方向的运行时间影响堵转判断。 */
				direction_started_ticks = now_ticks;
				direction_request_valid = 1U;
			}
		}
		/* 锁定分支每轮都返回；未收到稳定反向请求时不会进入正常开桥流程。 */
		return;
	}
	/* 上电后的首次去抖：稳定方向尚未建立，不进入常规方向跟踪流程。 */
	if (fr_stable_valid == 0U) {
		if ((unsigned long)(now_ticks - fr_candidate_since_ticks) >= MY_MOTOR_FR_DEBOUNCE_TICKS) {
			fr_stable_level = fr_candidate_level;
			fr_stable_valid = 1U;
			pending_direction = (fr_stable_level == MY_MOTOR_FR_FORWARD_LEVEL) ?
				MY_MOTOR_FORWARD : MY_MOTOR_REVERSE;
			direction_request_valid = 1U;
			/* 首次方向确认后仍保持桥臂关闭，并从确认时刻开始计算 20 ms 死区。 */
			MyMotor_DisableBridge();
			motor_state = MY_MOTOR_STOPPED;
			direction_off_since_ticks = now_ticks;
		}
		/* 首次去抖分支本轮直接返回，不在同一轮完成死区检查和开桥。 */
		return;
	}
	/* 稳定运行后若 FR 与稳定电平不同，说明方向输入正处于切换/去抖过程。 */
	if ((fr_level ^ fr_stable_level) == 1U) {
		if ((unsigned long)(now_ticks - fr_candidate_since_ticks) >= MY_MOTOR_FR_DEBOUNCE_TICKS) {
			fr_stable_level = fr_candidate_level;
			pending_direction = (fr_stable_level == MY_MOTOR_FR_FORWARD_LEVEL) ?
				MY_MOTOR_FORWARD : MY_MOTOR_REVERSE;
			/* 新方向稳定后更新待执行方向和死区起点；候选变化时已提前关桥。 */
			direction_off_since_ticks = now_ticks;
			direction_request_valid = 1U;
		}
		/* 去抖分支无论本轮是否刚好确认，都不继续开桥。 */
		return;
	}
	/* 防御性恢复：稳定输入有效但请求标志无效时，按稳定电平重建待执行方向。 */
	if (direction_request_valid == 0U) {
		pending_direction = (fr_stable_level == MY_MOTOR_FR_FORWARD_LEVEL) ?
			MY_MOTOR_FORWARD : MY_MOTOR_REVERSE;
		direction_request_valid = 1U;
	}
	/* 仅在桥臂已关闭且死区达到 20 ms 后，才允许切换到待执行方向。 */
	if (motor_state == MY_MOTOR_STOPPED &&
		(unsigned long)(now_ticks - direction_off_since_ticks) >= MY_MOTOR_DIRECTION_DEADTIME_TICKS) {
		EPWM_EnableOutput(MY_MOTOR_PWM_CHANNELS);
		/* 选定方向的一侧切到 PWM 复用，另一侧保持普通 GPIO 低电平。 */
		if (pending_direction == MY_MOTOR_FORWARD) {
			P17CFG = 0x00U;
			P17 = 0U;
			P16CFG = 0x15U;
			motor_state = MY_MOTOR_FORWARD;
		} else {
			P16CFG = 0x00U;
			P16 = 0U;
			P17CFG = 0x16U;
			motor_state = MY_MOTOR_REVERSE;
		}
		direction_started_ticks = MyTimer_GetTick100us();
		/* 新方向开通后重新起算启动宽限期，并清除之前累计的过流时间。 */
		stall_overcurrent_active = 0U;
	}
}

/* 电机前台任务：平滑占空比，并在方向请求有效且死区结束后开通对应桥臂。 */
void MyMotor_Task(void) {
	unsigned long now_ticks;

	now_ticks = MyTimer_GetTick100us();
	MyMotor_UpdateDuty(now_ticks);
	MyMotor_UpdateDirection(now_ticks);
}
