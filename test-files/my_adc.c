/* ADC 模块职责：只采样和产出事件，不直接操作电机堵转逻辑。
 * 应用层决定将 SC 结果交给 Motor 模块，并决定是否把占空比传入 PWM 触发延时计算。
 */
#include "my_adc.h"
#include "my_timer.h"
#include "my_motor.h"
#include "my_uart.h"
#include "adc.h"
#include "pga.h"

#define MY_ADC_SAMPLE_PERIOD_TICKS 100UL   /* 10 ms 遥测轮次目标周期，当前间隔受前台和发送阻塞影响。 */
#define MY_ADC_TIMEOUT_TICKS 100UL         /* 10 ms 转换硬件等待超时。 */
#define MY_ADC_PWM_PERIOD_TICKS 1200UL     /* 24 MHz 下 20 kHz PWM 的计数基准。 */
#define MY_ADC_AVERAGE_SAMPLES 4U          /* 每通道丢弃一次首样，保留四次有效平均。 */

/* 通道别名直接映射到芯片 ADC 通道宏，避免状态常量与寄存器通道之间重复分支。 */
#define MY_ADC_CHANNEL_VREF ADC_CH_18
#define MY_ADC_CHANNEL_SC ADC_CH_31
#define MY_ADC_CHANNEL_VAD ADC_CH_10

#define MY_ADC_PHASE_SC 0U
#define MY_ADC_PHASE_VREF 1U
#define MY_ADC_PHASE_VAD 2U
#define MY_ADC_RESULT_VREF_READY 1U
#define MY_ADC_RESULT_SC_READY 2U
#define MY_ADC_RESULT_VAD_READY 3U

/* 两个时间戳的单位均为 100us tick；放入 XDATA，避免占用紧张的片内 DATA。 */
/* 上次遥测周期到期时的时间锚点，用于计算下一轮 10ms 目标周期。 */
static unsigned long xdata last_sample_ticks;
/* 当前转换/硬件触发等待的起点，用于转换超时检查。 */
static unsigned long xdata conversion_started_ticks;

/* 当前通道采样组的累加和；首个转换结果丢弃，后续四个结果加入此和。 */
static unsigned int sample_total;
/* 最近完成采样组的平均原始值；具体属于哪个通道由 pending_result 标识。 */
static unsigned int completed_sample_raw;

/* 本轮遥测缓存：VREF 用于 VREF/I_TRIP，V_AD 用于最后发送整行遥测。 */
static unsigned int telemetry_vref_snapshot_raw;
/* 最新完成的 SC 原始值，跨模块共享；其他模块通过 MY_ADC_SC_RAW() 读取。 */
unsigned int sc_raw;
static unsigned int telemetry_vad_snapshot_raw;

/* 当前采样组已完成的转换次数，包含被丢弃的首样；达到 5 次后形成四样本平均。 */
static unsigned char sample_count;
/* 软件侧转换组是否已启动；硬件触发模式下也覆盖等待 PWM 边沿的阶段。 */
static unsigned char conversion_active;
/* ADC 内部单槽结果标记：ChannelTask 产生，Task 消费；不等同于对外事件码。 */
static unsigned char pending_result;
/* 遥测周期到期锁存位；前台延迟期间多次到期合并为一次待执行遥测轮次。 */
static unsigned char telemetry_due;
/* 当前采样通道阶段，决定下一组选择 SC、VREF 还是 V_AD。 */
static unsigned char sampling_phase;
/* PWM 硬件触发已布置、但尚未确认转换完成；用于区分触发等待和异常空闲。 */
static unsigned char hardware_trigger_waiting;

static void MyAdc_SendTelemetry(void) {
	unsigned int vref_centivolts;
	unsigned int trip_current_centiamps;
	unsigned int motor_current_centiamps;
	unsigned int vad_centivolts;
	unsigned int values[4];
	unsigned int value;
	unsigned int whole;
	unsigned char field;
	unsigned char count;
	char digits[5];

	/* 12 位 ADC 原始码范围为 0..4095；乘比例系数后加 2047，再除 4095，按最近整数取整。 */
	/* VREF：以内部 3.00 V 参考换算，结果单位为 0.01 V。 */
	vref_centivolts = (unsigned int)(((unsigned long)telemetry_vref_snapshot_raw * 300UL + 2047UL) / 4095UL);
	/* I_TRIP：按板级关系 I_TRIP=VREF/(10*0.05ohm)=2*VREF，结果单位为 0.01 A。 */
	trip_current_centiamps = (unsigned int)(((unsigned long)telemetry_vref_snapshot_raw * 600UL + 2047UL) / 4095UL);
	/* I_MOTOR：PGA 增益为 8、采样电阻为 0.05ohm，对应 ADC 满量程约 7.50 A。 */
	motor_current_centiamps = (unsigned int)(((unsigned long)sc_raw * 750UL + 2047UL) / 4095UL);
	/* V_AD：3.00 V ADC 满量程经 11:1 分压对应外部 33.00 V，结果单位为 0.01 V。 */
	vad_centivolts = (unsigned int)(((unsigned long)telemetry_vad_snapshot_raw * 3300UL + 2047UL) / 4095UL);
	values[0] = vref_centivolts;
	values[1] = trip_current_centiamps;
	values[2] = motor_current_centiamps;
	values[3] = vad_centivolts;

	for (field = 0U; field < 4U; field++) {
		value = values[field];
		switch (field) {
			case 0U:
				MyUart_WriteString("VREF=");
				break;

			case 1U:
				MyUart_WriteString("V,I_TRIP=");
				break;

			case 2U:
				MyUart_WriteString("A,I_MOTOR=");
				break;

			default:
				MyUart_WriteString("A,V_AD=");
				break;
		}

		whole = value / 100U;
		count = 0U;
		do {
			digits[count++] = (char)('0' + (whole % 10U));
			whole /= 10U;
		} while (whole != 0U);
		while (count != 0U) {
			MyUart_WriteByte((unsigned char)digits[--count]);
		}
		MyUart_WriteByte('.');
		MyUart_WriteByte((unsigned char)('0' + ((value % 100U) / 10U)));
		MyUart_WriteByte((unsigned char)('0' + (value % 10U)));
	}
	MyUart_WriteString("V\r\n");
}

/* 启动一次转换：SC 有 PWM 时同步触发，其他情况使用软件触发。
 * - SC 且占空比不为 0：由 PWM4 上升沿硬件触发，并按占空比计算近似脉冲中部延时。
 * - 其他通道或占空比为 0：使用 ADGO 软件触发。
 * - 每次启动前先清转换标志并关闭旧硬件触发，防止通道切换时残留触发。
 */
static void MyAdc_StartConversion(unsigned long now_ticks) {
	unsigned char duty_percent;

	/* 清除上次转换完成标志，并先关闭旧硬件触发，避免通道切换后被残留触发误启动。 */
	ADC_ClearIntFlag();
	ADC_DisableHardwareTrig();
	/* 本次转换只读取一次占空比，保证判断是否启用 PWM 触发和延时计算使用同一值。 */
	duty_percent = MY_MOTOR_DUTY_PERCENT();

	if (sampling_phase == MY_ADC_PHASE_SC && duty_percent != 0U) {

		unsigned long delay_ticks;
		unsigned int trigger_delay;

		/* 高电平脉宽约为周期*duty/100；取其一半得到脉冲中点对应的计数延时。 */
		delay_ticks = (MY_ADC_PWM_PERIOD_TICKS * duty_percent) / 200UL;
		/* 依当前 ADC 触发延时实现提前扣除 4 个计数，再写入硬件触发延时寄存器。 */
		trigger_delay = (delay_ticks > 4UL) ? (unsigned int)(delay_ticks - 4UL) : 0U;
		/* SC 且电机有 PWM：配置 PWM4 上升沿触发；此处只布置触发，转换将在边沿到来后开始。 */
		ADC_ConfigHardwareTrig(ADC_TG_PWM4, ADC_TG_RISING);
		ADC_SetTrigDelayTime(trigger_delay);
		ADC_EnableHardwareTrig();
		hardware_trigger_waiting = 1U;
	}
	else {
		/* VREF/V_AD 或 SC 无 PWM：不依赖外部边沿，立即用 ADGO 软件启动一次转换。 */
		ADC_DisableHardwareTrig();
		ADC_GO();
		hardware_trigger_waiting = 0U;
	}
	/* 记录本次转换启动/等待起点；硬件触发路径的超时也从等待 PWM 边沿时开始计。 */
	conversion_started_ticks = now_ticks;
}

void MyAdc_Init(void) {
	/* 配置板上三路模拟输入：P15/AN18=VREF，P31/PGAP=电流检测输入，P24/AN10=V_AD。 */
	P15CFG = 0x01U;
	P31CFG = 0x01U;
	P24CFG = 0x01U;

	/* SC 电流通道经 PGA 单端 PGAP 输入，增益为 8；关闭 SHA 后启动 PGA 模拟链路。 */
	PGA_EnableNormalMode(PGA_NORM_SINGLE);
	PGA_ConfigInput(PGA_SIG_PGAP);
	PGA_ConfigGain(PGA_GAIN_8);
	PGA_DisableSHA();
	PGA_Start();

	/* ADC 由前台轮询完成标志，不使用 ADC 中断；初始化时先禁止硬件触发。 */
	ADC_DisableInt();
	ADC_DisableHardwareTrig();
	/* 使用内部 3.0 V 参考并开启 ADC LDO；转换时钟为 Fsys/16，结果右对齐。 */
	ADC_ConfigADCVref(ADC_VREF_3V);
	ADC_EnableLDO();
	ADC_ConfigRunMode(ADC_CLK_DIV_16, ADC_RESULT_RIGHT);
	/* 把 AN31 内部连接到 PGA 输出，并将 SC 设为首次任务启动时的默认采样通道。 */
	ADC_ConfigAN31(ADC_CH_31_PGA_ANA);
	ADC_EnableChannel(MY_ADC_CHANNEL_SC);
	/* ADC_Start 仅使能 ADC 模块；单次转换由后续 PWM 硬件触发或 ADC_GO() 启动。 */
	ADC_Start();

	/* 建立首轮调度基准，并清空遥测快照及转换状态，初始阶段从 SC 常态采样开始。 */
	last_sample_ticks = MyTimer_GetTick100us();
	telemetry_vref_snapshot_raw = 0U;
	sc_raw = 0U;
	telemetry_vad_snapshot_raw = 0U;
	conversion_active = 0U;
	telemetry_due = 0U;
	sampling_phase = MY_ADC_PHASE_SC;
	hardware_trigger_waiting = 0U;
	pending_result = MY_ADC_EVENT_NONE;
}

/* 统一检查 ADC 状态：返回结果就绪状态，必要时执行超时或异常恢复。
 * 返回 1：转换完成标志有效，调用方可以读取 ADC 结果。
 * 返回 0：转换仍在进行、正在等待 PWM 触发，或本次已执行异常恢复。
 */
static unsigned char MyAdc_UpdateConversionState(unsigned long now_ticks) {
	unsigned long elapsed_ticks;

	/* 使用无符号差值处理 100us tick 回绕，得到本次转换已等待的 tick 数。 */
	elapsed_ticks = (unsigned long)(now_ticks - conversion_started_ticks);

	if (conversion_active == 0U) {
		/* 软件状态显示没有活动转换，且硬件也空闲：无需处理。 */
		if (ADC_IS_BUSY == 0U) {
			return 0U;
		}
	}
	else if (ADC_IS_BUSY != 0U) {
		/* 转换仍忙且未超时，保持当前状态，交由后续前台调用继续检查。 */
		if (elapsed_ticks < MY_ADC_TIMEOUT_TICKS) {
			return 0U;
		}
	}
	else {
		/* ADC 已不忙且完成标志有效，结果已就绪；由调用方读取并清理触发配置。 */
		if (ADC_GetIntFlag() != 0U) {
			return 1U;
		}
		/* PWM 硬件触发尚未开始转换时，允许等待到超时期限。 */
		if (hardware_trigger_waiting != 0U && elapsed_ticks < MY_ADC_TIMEOUT_TICKS) {
			return 0U;
		}
	}

	/* 落到这里表示硬件忙闲状态矛盾、转换超时，或等待触发期间未得到有效结果。 */
	ADC_DisableHardwareTrig();
	ADC_Stop();
	ADCON0 &= (unsigned char)~ADC_ADCON0_ADGO_Msk;
	ADC_ClearIntFlag();
	ADC_Start();

	/* 丢弃不完整采样组并回到 SC 常态阶段，后续由总任务重新启动采样。 */
	conversion_active = 0U;
	hardware_trigger_waiting = 0U;
	sample_total = 0U;
	sample_count = 0U;
	sampling_phase = MY_ADC_PHASE_SC;
	telemetry_due = 0U;
	return 0U;
}

/* 空闲时按当前阶段启动采样；转换中则等待结果、平均样本并发布 READY 事件。 */
static void MyAdc_ChannelTask(unsigned long now_ticks) {
	if (conversion_active == 0U) {
		if (ADC_IS_BUSY != 0U) {
			MyAdc_UpdateConversionState(now_ticks);
			return;
		}

		switch (sampling_phase) {
			case MY_ADC_PHASE_VREF:
				ADC_EnableChannel(MY_ADC_CHANNEL_VREF);
				break;

			case MY_ADC_PHASE_VAD:
				ADC_EnableChannel(MY_ADC_CHANNEL_VAD);
				break;

			case MY_ADC_PHASE_SC:
			default:
				ADC_EnableChannel(MY_ADC_CHANNEL_SC);
				break;
		}
		sample_total = 0U;
		sample_count = 0U;
		conversion_active = 1U;
		MyAdc_StartConversion(now_ticks);
		return;
	}

	if (MyAdc_UpdateConversionState(now_ticks) == 0U) {
		return;
	}

	/* 硬件触发只负责启动一次转换；完成后立即关闭，避免残留触发抢占通道切换。 */
	ADC_DisableHardwareTrig();
	hardware_trigger_waiting = 0U;

	/* 每组转换共进行 5 次：第一次丢弃，后四次累加。 */
	if (sample_count != 0U) {
		sample_total += ADC_GetADCResult();
	}
	sample_count++;

	if (sample_count <= MY_ADC_AVERAGE_SAMPLES) {
		MyAdc_StartConversion(now_ticks);
		return;
	}

	conversion_active = 0U;
	completed_sample_raw = (unsigned int)((sample_total + 2U) / MY_ADC_AVERAGE_SAMPLES);

	/* 一组采样完成后记录对应通道事件，遥测通道随后由本模块内部消费。 */
	switch (sampling_phase) {
		case MY_ADC_PHASE_VREF:
			pending_result = MY_ADC_RESULT_VREF_READY;
			break;

		case MY_ADC_PHASE_SC:
			pending_result = MY_ADC_RESULT_SC_READY;
			break;

		case MY_ADC_PHASE_VAD:
		default:
			pending_result = MY_ADC_RESULT_VAD_READY;
			break;
	}
}

/* ADC 前台总任务：推进采样状态并直接返回一个就绪事件。
 * SC 常态采样，遥测到期后依次采 VREF、V_AD，再回到 SC；每次调用不忙等硬件。
 */
unsigned char MyAdc_Task(void) {
	unsigned long now_ticks;
	unsigned char event;

	/* 若没有尚待处理的内部结果，先更新时间并推进一次采样；已有结果时先处理结果，避免被新采样覆盖。 */
	if (pending_result == MY_ADC_EVENT_NONE) {
		/* 一次读取统一供遥测周期判断、转换超时判断和本次启动时间戳使用。 */
		now_ticks = MyTimer_GetTick100us();

		/* 遥测请求只在 SC 常态阶段产生；一个待处理标志即可合并调度延迟期间的多次到期。 */
		if (sampling_phase == MY_ADC_PHASE_SC && telemetry_due == 0U &&
			(unsigned long)(now_ticks - last_sample_ticks) >= MY_ADC_SAMPLE_PERIOD_TICKS) {
			last_sample_ticks = now_ticks;
			telemetry_due = 1U;
		}

		/* SC 组已经结束且结果已交给应用层时，开始连续的 VREF -> V_AD 遥测序列。 */
		if (sampling_phase == MY_ADC_PHASE_SC && telemetry_due != 0U &&
			conversion_active == 0U) {
			sampling_phase = MY_ADC_PHASE_VREF;
			telemetry_due = 0U;
		}

		MyAdc_ChannelTask(now_ticks);
	}

	/* 本次任务没有产出完整通道结果，或转换状态检查已恢复异常，当前没有数据需要分发。 */
	if (pending_result == MY_ADC_EVENT_NONE) {
		return MY_ADC_EVENT_NONE;
	}

	/* 保存内部结果码到局部变量，下面按通道消费 completed_sample_raw；它此时对应当前结果码所指的通道。 */
	event = pending_result;
	switch (event) {
		case MY_ADC_RESULT_SC_READY:
			/* 同一份 SC 结果同时更新共享最新值供 Motor 读取，并留作本轮 I_MOTOR 遥测值。 */
			sc_raw = completed_sample_raw;
			if (telemetry_due != 0U) {
				/* 遥测周期在 SC 采样过程中到期：本次 SC 结果交付后，转入 VREF -> V_AD 序列。 */
				sampling_phase = MY_ADC_PHASE_VREF;
				telemetry_due = 0U;
			}
			break;

		case MY_ADC_RESULT_VREF_READY:
			/* 缓存本轮遥测的 VREF 原始值，供后续 I_TRIP 换算；接下来采 V_AD。 */
			telemetry_vref_snapshot_raw = completed_sample_raw;
			sampling_phase = MY_ADC_PHASE_VAD;
			break;

		case MY_ADC_RESULT_VAD_READY:
			/* 保存本轮最后一路原始值；三路快照齐备后发送整行，再恢复 SC 常态采样。 */
			telemetry_vad_snapshot_raw = completed_sample_raw;
			MyAdc_SendTelemetry();
			sampling_phase = MY_ADC_PHASE_SC;
			break;

		default:
			return MY_ADC_EVENT_NONE;
	}

	/* 内部结果已经消费，清空待处理标记；内部 VREF/V_AD 结果不暴露给应用层。 */
	pending_result = MY_ADC_EVENT_NONE;
	/* 只有 SC 是对外事件；应用收到后可通过 MY_ADC_SC_RAW() 读取本次 SC 采样值。 */
	return (event == MY_ADC_RESULT_SC_READY) ? MY_ADC_EVENT_SC_READY : MY_ADC_EVENT_NONE;
}
