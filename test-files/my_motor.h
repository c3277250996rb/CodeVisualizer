#ifndef MY_MOTOR_H
#define MY_MOTOR_H

#define MY_MOTOR_FR_FORWARD_LEVEL 1U

void MyMotor_Init(void);
void MyMotor_Task(void);
extern unsigned char motor_target_duty_percent;
#define MyMotor_RequestDutyPercent(duty_percent) (motor_target_duty_percent = ((duty_percent) > 100U ? 100U : (duty_percent)))
extern unsigned char motor_duty_percent;
#define MY_MOTOR_DUTY_PERCENT() (motor_duty_percent)
void MyMotor_UpdateCurrentSample(unsigned int sc_sample_raw);

#endif